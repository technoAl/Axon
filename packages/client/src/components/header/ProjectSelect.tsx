import * as React from "react";
import { FormControl, MenuItem, Select } from "@material-ui/core";
import { useQuery } from "@apollo/react-hooks";
import gql from "graphql-tag";
import * as GetProjectsTypes from "./__generated__/GetProjects";

const GET_PROJECTS = gql`
  query GetProjects {
    projects {
      id
      name
    }
  }
`;

export default function ProjectSelect() {
  // const [projects] = React.useState([
  //   { id: 0, name: "2020 Power Cells" },
  //   { id: 1, name: "2019" },
  //   { id: 2, name: "2018" }
  // ]);
  const [selected, setSelected] = React.useState("");

  const { data, loading, error } = useQuery<GetProjectsTypes.GetProjects, GetProjectsTypes.GetProjects>(GET_PROJECTS);

  if (loading) return <p>LOADING</p>;
  if (error || !data) return <p>ERROR</p>;

  return (
    <FormControl>
      <Select value={selected} onChange={(e) => setSelected(e.target.value as string)}>
        {data.projects.map((project) => (
          <MenuItem key={project.id} value={project.id}>
            {project.name}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}