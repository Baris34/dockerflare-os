import { describe, expect, it, vi } from "vitest";
import type { ConfiguratorUIHierarchyItem, HierarchyPickerProps, NoticeProps } from "@gadgets/configurator-ui";
import configurator from "../src/configurator/branch-configurator-ui";
import type { BranchConfiguratorValues } from "../src/configurator/branch-configurator-types";

// Capture the controls emitted by the frame. Drive their public callbacks, as the runtime does.
const controls = vi.hoisted(() => ({ picker: undefined as HierarchyPickerProps | undefined, notices: [] as NoticeProps[] }));
vi.mock("@gadgets/configurator-ui", () => ({
  h(component: string, props: unknown) {
    if (component === "HierarchyPicker") controls.picker = props as HierarchyPickerProps;
    if (component === "Notice") controls.notices.push(props as NoticeProps);
  },
  Section: "Section", HierarchyPicker: "HierarchyPicker", Notice: "Notice",
}));

const PROJECT = "33333333-3333-4333-8333-333333333333";
const REPOSITORY = "44444444-4444-4444-8444-444444444444";
const REF = "refs/heads/feature/fix+#1";
const COMMIT = "1".repeat(40);
const NEW_COMMIT = "2".repeat(40);

function open() {
  let values: BranchConfiguratorValues = { ...configurator.initial };
  const ui = {
    repositoryCatalog: vi.fn(async (_project: string) => [{ id: REPOSITORY, name: " Accounts Service" }]),
    listProjects: vi.fn(async (_cursor: string | null) => ({ items: [{ id: PROJECT, name: " Project / Finance" }] })),
    listRepositories: vi.fn(async (_project: string, _cursor: string | null) =>
      ({ items: [{ id: REPOSITORY, name: " Accounts Service" }] })),
    listBranches: vi.fn(async (_project: string, _repository: string, cursor: string | null) => cursor
      ? { items: [{ refName: REF, commitId: COMMIT }] }
      : { items: [{ refName: "refs/heads/main", commitId: NEW_COMMIT }], nextCursor: "next page+" }),
    confirmBranch: vi.fn(async (_project: string, _repository: string, _ref: string, commitId: string):
      Promise<{ commitId: string; resourceUrl?: string }> => ({ resourceUrl: "https://example.test/confirmed", commitId })),
  };
  const render = () => {
    controls.picker = undefined;
    controls.notices.length = 0;
    configurator.render({
      ui, values, setValues: patch => { values = { ...values, ...patch }; },
      ensureResources: async () => true, clearFields() {},
    });
  };
  const frame = {
    ui, render, values: () => values,
    ready: () => configurator.isReady({ values }),
    collect: () => configurator.resourceUrl({ values, ui }),
    list: (cursor: string | null = null, query = "") => controls.picker!.loadItems({ parentId: controls.picker!.root.id, query, cursor }),
    choose(item: ConfiguratorUIHierarchyItem) {
      controls.picker!.onChange(item.id, item);
      render();
    },
    async openRepository() {
      frame.choose((await frame.list()).items[0]!);
      frame.choose((await frame.list()).items[0]!);
    },
    async chooseBranch() {
      await frame.openRepository();
      frame.choose((await frame.list("next page+")).items[0]!);
    },
  };
  render();
  return frame;
}

describe("choosing a pinned Azure branch", () => {
  it("searches and pages the whole project without redownloading 5,200 repository names", async () => {
    const frame = open();
    frame.choose((await frame.list()).items[0]!);
    const repos = Array.from({length: 5200}, (_, i) => ({id: String(i), name: i >= 5000 ? "Finance-" + i : "Other-" + i}));
    frame.ui.repositoryCatalog.mockResolvedValue(repos);
    expect(controls.picker?.searchPlaceholder).toBeTruthy();
    expect((await frame.list()).items).toHaveLength(100);
    const first = await frame.list(null, " FINANCE ");
    expect(first.items).toHaveLength(100);
    expect(first.items[0]?.id).toBe("5000");
    const last = await frame.list(first.nextCursor!, "finance");
    expect(last.items.at(-1)?.id).toBe("5199");
    expect(last.nextCursor).toBeFalsy();
    expect((await frame.list(null, "absent")).notice).toMatch(/no matching/i);
    expect(frame.ui.repositoryCatalog).toHaveBeenCalledTimes(1);
    frame.choose(last.items.at(-1)!);
    expect(frame.values().repositoryId).toBe("5199");
  });

  it("retries a failed catalog and drops it when the project changes", async () => {
    const frame = open();
    frame.choose((await frame.list()).items[0]!);
    frame.ui.repositoryCatalog.mockRejectedValueOnce(new Error("Azure unavailable"));
    await expect(frame.list()).rejects.toThrow("Azure unavailable");
    expect((await frame.list(null, "Accounts")).items).toHaveLength(1);
    controls.notices.find(n => n.action?.label === "Change project")!.action!.onClick();
    frame.render();
    frame.choose({id: "project-two", title: "Another", kind: "leaf"});
    frame.ui.repositoryCatalog.mockResolvedValue([]);
    expect((await frame.list()).items).toEqual([]);
    expect(frame.ui.repositoryCatalog).toHaveBeenLastCalledWith("project-two");
  });
  it("requires an explicit branch, forwards the cursor, and confirms only the chosen tip", async () => {
    const frame = open();
    expect(configurator.initialValuesFromResourceUrl()).toEqual({});
    expect(frame.ready()).toBe(false);
    await frame.openRepository();
    const first = await frame.list();
    expect(frame.ready()).toBe(false);
    expect(first.nextCursor).toBe("next page+");
    const second = await frame.list(first.nextCursor);
    expect(frame.ui.listBranches).toHaveBeenLastCalledWith(PROJECT, REPOSITORY, "next page+");
    expect(second.items[0]).toMatchObject({ id: REF, title: "feature/fix+#1", subtitle: COMMIT });
    frame.choose(second.items[0]!);
    expect(frame.values()).toMatchObject({ projectName: " Project / Finance", repositoryName: " Accounts Service" });
    expect(frame.ready()).toBe(true);
    await expect(frame.collect()).resolves.toBe("https://example.test/confirmed");
    expect(frame.ui.confirmBranch).toHaveBeenCalledWith(PROJECT, REPOSITORY, REF, COMMIT);
  });

  it("distinguishes an empty repository from a load failure and allows a retry", async () => {
    const frame = open();
    await frame.openRepository();
    frame.ui.listBranches.mockRejectedValueOnce(new Error("Azure access denied"));
    await expect(frame.list()).rejects.toThrow("Azure access denied");
    frame.ui.listBranches.mockResolvedValueOnce({ items: [] });
    expect(await frame.list()).toMatchObject({ items: [], notice: expect.stringMatching(/no branches/i) });
    expect(frame.ready()).toBe(false);
  });

  it("requires a second submission at the new SHA when Azure reports a moved branch", async () => {
    const frame = open();
    await frame.chooseBranch();
    frame.ui.confirmBranch.mockResolvedValueOnce({ commitId: NEW_COMMIT });
    await expect(frame.collect()).rejects.toThrow(/branch.*moved/i);
    frame.render();
    expect(frame.values().commitId).toBe(NEW_COMMIT);
    await expect(frame.collect()).resolves.toBe("https://example.test/confirmed");
    expect(frame.ui.confirmBranch).toHaveBeenLastCalledWith(PROJECT, REPOSITORY, REF, NEW_COMMIT);
  });

  it("drops a late moved-tip response when the user has changed the branch", async () => {
    const frame = open();
    await frame.chooseBranch();
    const pending = Promise.withResolvers<{ commitId: string }>();
    frame.ui.confirmBranch.mockImplementationOnce(() => pending.promise);
    const oldRequest = frame.collect();
    controls.notices.find(notice => notice.action?.label === "Change branch")!.action!.onClick();
    frame.render();
    frame.choose((await frame.list()).items[0]!);
    pending.resolve({ commitId: "3".repeat(40) });
    await expect(oldRequest).rejects.toThrow();
    expect(frame.values()).toMatchObject({ refName: "refs/heads/main", commitId: NEW_COMMIT });
  });
});
