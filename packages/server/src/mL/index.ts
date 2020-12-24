import { Test, Video, Checkpoint, Export, ProjectStatus } from "../schema/__generated__/graphql";
import { Project } from "../store";

import PseudoDatabase from "../datasources/PseudoDatabase";
import { ProjectData } from "../datasources/PseudoDatabase";
import Trainer from "./Trainer";
import Exporter from "./Exporter";
import Tester from "./Tester";
import Docker from "./Docker";

export const DATASET_IMAGE = "gcperkins/wpilib-ml-dataset:latest";
export const METRICS_IMAGE = "gcperkins/wpilib-ml-metrics:latest";
export const EXPORT_IMAGE = "gcperkins/wpilib-ml-tflite:latest";
export const TRAIN_IMAGE = "gcperkins/wpilib-ml-train:latest";
export const TEST_IMAGE = "gcperkins/wpilib-ml-test:latest";

//trainer state enumeration
enum TrainerState {
  NO_DOCKER_INSTALLED,
  SCANNING_FOR_DOCKER,
  SCANNING_PROJECTS,
  DATASET_PULL,
  METRICS_PULL,
  TRAINER_PULL,
  EXPORT_PULL,
  TEST_PULL,
  READY
}

//training status enumeration
export enum TrainingStatus {
  NOT_TRAINING,
  PREPARING,
  TRAINING,
  PAUSED
}

type ProjectStati = {
  [id: string]: ProjectStatus;
};

export default class MLService {
  projects: ProjectData;
  trainer_state: TrainerState;
  status: ProjectStati;

  constructor() {
    this.trainer_state = TrainerState.SCANNING_FOR_DOCKER;
    this.status = {};
    this.prepare();
  }

  private async prepare(): Promise<void> {
    if (!(await Docker.testDaemon())) {
      this.trainer_state = TrainerState.NO_DOCKER_INSTALLED;
      console.log("docker is not responding");
      Promise.resolve();
      return;
    }

    this.trainer_state = TrainerState.SCANNING_PROJECTS;
    const database = await PseudoDatabase.retrieveDatabase();
    Object.values(database).forEach((project: ProjectData) => this.addStatus(project));

    this.trainer_state = TrainerState.DATASET_PULL;
    await Docker.pull(DATASET_IMAGE);

    this.trainer_state = TrainerState.METRICS_PULL;
    await Docker.pull(METRICS_IMAGE);

    this.trainer_state = TrainerState.TRAINER_PULL;
    await Docker.pull(TRAIN_IMAGE);

    this.trainer_state = TrainerState.EXPORT_PULL;
    await Docker.pull(EXPORT_IMAGE);

    this.trainer_state = TrainerState.TEST_PULL;
    await Docker.pull(TEST_IMAGE);

    this.trainer_state = TrainerState.READY;
    console.log("image pull complete");
    Promise.resolve();
  }

  async start(iproject: Project): Promise<string> {
    const project = await PseudoDatabase.retrieveProject(iproject.id);
    const ID = project.id;

    this.updateLastStep(ID, project.hyperparameters.epochs);
    this.updateState(ID, TrainingStatus.PREPARING);

    await Trainer.writeParameterFile(ID);

    await Trainer.handleOldData(ID);

    await Trainer.moveDataToMount(ID);

    await Trainer.extractDataset(ID);

    this.updateState(ID, TrainingStatus.TRAINING);
    this.updateStep(ID, 0);

    await Trainer.trainModel(ID);

    await Trainer.updateCheckpoints(ID);

    this.updateState(ID, TrainingStatus.NOT_TRAINING);
    project.containerIDs.train = null;
    PseudoDatabase.pushProject(project);
    return "training complete";
  }

  async export(id: string, checkpointNumber: number, name: string): Promise<string> {
    await Exporter.locateCheckpoint(id, checkpointNumber);

    const exp: Export = await Exporter.createExport(id, name);

    await Exporter.createDestinationDirectory(exp);

    await Exporter.updateCheckpointStatus(id, checkpointNumber, true);

    await Exporter.writeParameterFile(id, checkpointNumber, exp);

    await Exporter.exportCheckpoint(id);

    await Exporter.saveExport(id, exp, checkpointNumber);

    await Exporter.updateCheckpointStatus(id, checkpointNumber, false);

    return "exported";
  }

  async test(testName: string, projectID: string, exportID: string, videoID: string): Promise<string> {
    const test: Test = await Tester.createTest(testName, projectID, exportID, videoID);

    const project: ProjectData = await PseudoDatabase.retrieveProject(projectID);

    const mountedModelPath = await Tester.mountModel(test, project.directory);

    const mountedVideoPath = await Tester.mountVideo(test, project.directory);

    await Tester.writeParameterFile(project.directory, mountedModelPath, mountedVideoPath);

    await Tester.testModel(project.id);

    await Tester.saveOutputVid(test, project.directory);

    await Tester.saveTest(test, project.id);

    return "testing complete";
  }

  async halt(id: string): Promise<void> {
    const project: ProjectData = await PseudoDatabase.retrieveProject(id);
    if (project.containerIDs.train) await Docker.killContainer(project.containerIDs.train);
    else return Promise.reject("no trainjob found");
    this.status[project.id].trainingStatus = TrainingStatus.NOT_TRAINING;
  }

  async pauseTraining(id: string): Promise<void> {
    const project: ProjectData = await PseudoDatabase.retrieveProject(id);
    if (this.status[id].trainingStatus == TrainingStatus.PAUSED) return Promise.reject("training is already paused");
    if (project.containerIDs.train == null) return Promise.reject("no trainjob found");
    await Docker.pauseContainer(project.containerIDs.train);
    this.status[project.id].trainingStatus = TrainingStatus.PAUSED;
  }

  async resumeTraining(id: string): Promise<void> {
    const project: ProjectData = await PseudoDatabase.retrieveProject(id);
    if (this.status[id].trainingStatus != TrainingStatus.PAUSED) return Promise.reject("training is not paused");
    if (project.containerIDs.train == null) return Promise.reject("no trainjob found");
    await Docker.resumeContainer(project.containerIDs.train);
    this.status[project.id].trainingStatus = TrainingStatus.TRAINING;
  }

  public async getStatus(id: string): Promise<ProjectStatus> {
    return this.status[id];
  }

  public async updateCheckpoints(id: string): Promise<void> {
    const currentStep = await Trainer.updateCheckpoints(id);
    if (currentStep) this.updateStep(id, currentStep);
    Promise.resolve();
  }

  public async getCheckpoints(id: string): Promise<Checkpoint[]> {
    const project = await PseudoDatabase.retrieveProject(id);
    return Object.values(project.checkpoints);
  }

  public async getExports(id: string): Promise<Export[]> {
    const project = await PseudoDatabase.retrieveProject(id);
    return Object.values(project.exports);
  }

  public async getVideos(id: string): Promise<Video[]> {
    const project = await PseudoDatabase.retrieveProject(id);
    return Object.values(project.videos);
  }

  public addStatus(project: ProjectData): void {
    this.status[project.id] = {
      trainingStatus: TrainingStatus.NOT_TRAINING,
      currentEpoch: 0,
      lastEpoch: project.hyperparameters.epochs
    };
  }
  public updateState(id: string, newState: TrainingStatus): void {
    this.status[id].trainingStatus = newState;
  }
  public updateStep(id: string, newStep: number): void {
    this.status[id].currentEpoch = newStep;
  }
  public updateLastStep(id: string, newLast: number): void {
    this.status[id].lastEpoch = newLast;
  }
}