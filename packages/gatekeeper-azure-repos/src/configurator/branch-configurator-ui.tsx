import {
  h, HierarchyPicker, Notice, Section, type ConfiguratorUIHierarchyItem, type ConfiguratorUIHierarchyPage,
  type ConfiguratorUIRenderContext, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type { BranchConfiguratorRpc as Rpc, BranchConfiguratorValues as Values } from "./branch-configurator-types";

// The host collects outside render. Update a moved tip only if these are still the values on screen.
let form: ConfiguratorUIRenderContext<Rpc, Values> | undefined;

const clearBranch = { refName: null, commitId: null };
const clearRepository = { repositoryId: null, repositoryName: null, ...clearBranch };
const clearProject = { projectId: null, projectName: null, ...clearRepository };
const branchName = (ref: string) => ref.slice("refs/heads/".length);
// Provider names may start with spaces, and an unbroken ref or SHA must fit a narrow frame.
const identifierStyle = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
const namedItem = ({ id, name }: { id: string; name: string }): ConfiguratorUIHierarchyItem =>
  ({ id, title: name, subtitle: id, kind: "leaf" });

function picker(
  title: string, empty: string, load: (cursor: string | null) => Promise<ConfiguratorUIHierarchyPage>,
  choose: (item: ConfiguratorUIHierarchyItem) => void,
) {
  return <HierarchyPicker
    name={title}
    root={{ id: title, title }}
    loadItems={async ({ cursor }) => {
      const page = await load(cursor);
      return !cursor && !page.nextCursor && !page.items.length ? { ...page, notice: empty } : page;
    }}
    onChange={(_id, item) => { if (item) choose(item); }}
  />;
}

export default {
  initial: {},
  // Even a concrete resource suggested by an agent starts with the account holder's choice.
  initialValuesFromResourceUrl() { return {}; },
  isReady({ values }) {
    return Boolean(values.projectId && values.repositoryId && values.refName && values.commitId);
  },
  async resourceUrl({ values, ui }) {
    const { projectId, repositoryId, refName, commitId } = values;
    if (!projectId || !repositoryId || !refName || !commitId) throw new Error("Choose an Azure Repos branch.");
    const result = await ui.confirmBranch(projectId, repositoryId, refName, commitId);
    if (!result.resourceUrl) {
      if (form?.values === values) form.setValues({ commitId: result.commitId });
      throw new Error("The branch moved. Review the updated commit and add the connection again.");
    }
    return result.resourceUrl;
  },
  render(context) {
    form = context;
    const { values, setValues, ui } = context;
    const { projectId, repositoryId, refName } = values;
    return <Section>
      {projectId
        ? <Notice action={{ label: "Change project", onClick: () => setValues(clearProject) }}>
            Project · <bdi style={identifierStyle}>{values.projectName}</bdi>
          </Notice>
        : picker("Projects", "This account has no visible projects.", async cursor => {
            const page = await ui.listProjects(cursor);
            return { items: page.items.map(namedItem), nextCursor: page.nextCursor };
          }, item => setValues({ ...clearRepository, projectId: item.id, projectName: item.title }))}
      {projectId && (repositoryId
        ? <Notice action={{ label: "Change repository", onClick: () => setValues(clearRepository) }}>
            Repository · <bdi style={identifierStyle}>{values.repositoryName}</bdi>
          </Notice>
        : picker("Repositories", "This project has no visible Git repositories.", async cursor => {
            const page = await ui.listRepositories(projectId, cursor);
            return { items: page.items.map(namedItem), nextCursor: page.nextCursor };
          }, item => setValues({ ...clearBranch, repositoryId: item.id, repositoryName: item.title })))}
      {projectId && repositoryId && (refName
        ? <Notice action={{ label: "Change branch", onClick: () => setValues(clearBranch) }}>
            Branch · <bdi style={identifierStyle}>{branchName(refName)}</bdi><br />
            Commit · <code style={identifierStyle}>{values.commitId}</code>
          </Notice>
        : picker("Branches", "This repository has no branches visible to this account.", async cursor => {
            const page = await ui.listBranches(projectId, repositoryId, cursor);
            return {
              items: page.items.map(branch => ({
                id: branch.refName, title: branchName(branch.refName), subtitle: branch.commitId, kind: "leaf",
              })),
              nextCursor: page.nextCursor,
            };
          }, item => setValues({ refName: item.id, commitId: item.subtitle })))}
    </Section>;
  },
} satisfies ConfiguratorUISpec<Rpc, Values>;
