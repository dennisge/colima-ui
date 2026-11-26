import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { limaApi, type LimaInstance } from "../lib/api";
import { globalToast } from "../lib/globalToast";
import LinuxVMs from "./LinuxVMs.svelte";

vi.mock("../lib/api", () => ({
  limaApi: {
    create: vi.fn(),
    list: vi.fn(),
    shell: vi.fn(),
    start: vi.fn(),
    templates: vi.fn(),
  },
}));

vi.mock("../lib/globalToast", () => ({ globalToast: vi.fn() }));

const vm: LimaInstance = {
  name: "alpine-test",
  status: "Stopped",
  arch: "aarch64",
  cpus: "4",
  memory: "8 GiB",
  disk: "24 GiB",
  dir: "/tmp/lima/alpine-test",
};

function deferredStart() {
  let complete!: (message: string) => void;
  const pending = new Promise<string>((resolve) => { complete = resolve; });
  return { pending, complete };
}

describe("Linux VM operations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(limaApi.list).mockResolvedValue([]);
    vi.mocked(limaApi.templates).mockResolvedValue("ubuntu\nalpine");
  });

  it("submits the selected Alpine template and resource values and locks the new VM until it starts", async () => {
    const create = deferredStart();
    vi.mocked(limaApi.create).mockReturnValue(create.pending);
    render(LinuxVMs);

    const [newVmButton] = await screen.findAllByRole("button", { name: "New VM" });
    await fireEvent.click(newVmButton);
    await screen.findByRole("option", { name: "alpine" });
    await fireEvent.input(screen.getByLabelText("VM Name"), { target: { value: " Alpine-Test " } });
    await fireEvent.change(screen.getByLabelText("Template"), { target: { value: "alpine" } });
    await fireEvent.input(screen.getByLabelText("CPUs"), { target: { value: "4" } });
    await fireEvent.input(screen.getByLabelText("Memory (GiB)"), { target: { value: "8" } });
    await fireEvent.input(screen.getByLabelText("Disk (GiB)"), { target: { value: "24" } });
    await fireEvent.click(screen.getByRole("button", { name: "Create & Start" }));

    expect(limaApi.create).toHaveBeenCalledExactlyOnceWith({
      name: "alpine-test",
      template: "alpine",
      cpus: 4,
      memory: 8,
      disk: 24,
    });

    vi.mocked(limaApi.list).mockResolvedValue([vm]);
    await fireEvent.click(screen.getByRole("button", { name: "Refresh VMs" }));
    expect(await screen.findByText("Starting…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete VM" })).toBeDisabled();

    vi.mocked(limaApi.list).mockResolvedValue([{ ...vm, status: "Running" }]);
    create.complete("Created");
    expect(await screen.findByText("Running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("keeps Start locked across page remounts until the pending start completes", async () => {
    const start = deferredStart();
    vi.mocked(limaApi.list).mockResolvedValue([vm]);
    vi.mocked(limaApi.start).mockReturnValue(start.pending);
    const { unmount } = render(LinuxVMs);

    const button = await screen.findByRole("button", { name: "Start" });
    await fireEvent.click(button);
    expect(button).toBeDisabled();

    unmount();
    render(LinuxVMs);
    const remountedButton = await screen.findByRole("button", { name: "Start" });
    expect(remountedButton).toBeDisabled();
    await fireEvent.click(remountedButton);
    expect(limaApi.start).toHaveBeenCalledExactlyOnceWith(vm.name);
    expect(screen.getByText("Starting…")).toBeTruthy();

    vi.mocked(limaApi.list).mockResolvedValue([{ ...vm, status: "Running" }]);
    start.complete("Started");
    expect(await screen.findByText("Running")).toBeTruthy();
  });

  it("unlocks a VM after a failed start so it can be retried", async () => {
    vi.mocked(limaApi.list).mockResolvedValue([vm]);
    vi.mocked(limaApi.start).mockRejectedValue(new Error("download failed"));
    render(LinuxVMs);

    const button = await screen.findByRole("button", { name: "Start" });
    await fireEvent.click(button);

    await waitFor(() => expect(globalToast).toHaveBeenCalledWith("error", "Error: download failed"));
    expect(button).toBeEnabled();
    expect(screen.getByText("Stopped")).toBeTruthy();
  });

  it("runs ordinary commands with the selected guest directory and keeps it after a failed cd", async () => {
    vi.mocked(limaApi.list).mockResolvedValue([{ ...vm, status: "Running" }]);
    vi.mocked(limaApi.shell)
      .mockResolvedValueOnce("/\n")
      .mockResolvedValueOnce("tmp\n")
      .mockResolvedValueOnce("/tmp\n")
      .mockRejectedValueOnce(new Error("No such directory"))
      .mockResolvedValueOnce("/tmp\n")
      .mockResolvedValueOnce("/\n")
      .mockResolvedValueOnce("/home/guest\n")
      .mockResolvedValueOnce("/home/guest\n");
    render(LinuxVMs);
    await fireEvent.click(await screen.findByText(vm.name));
    const input = screen.getByRole("textbox");
    const button = screen.getByRole("button", { name: "Run" });

    for (const command of ["pwd", "ls", "cd /tmp", "cd missing", "pwd", "cd ..", "cd"]) {
      await fireEvent.input(input, { target: { value: command } });
      await fireEvent.click(button);
      await waitFor(() => expect(button).toBeEnabled());
    }

    expect(vi.mocked(limaApi.shell).mock.calls).toEqual([
      [vm.name, "pwd", "/"],
      [vm.name, "ls", "/"],
      [vm.name, "pwd -P", "/tmp"],
      [vm.name, "pwd -P", "/tmp/missing"],
      [vm.name, "pwd", "/tmp"],
      [vm.name, "pwd -P", "/tmp/.."],
      [vm.name, "printenv HOME", "/"],
      [vm.name, "pwd -P", "/home/guest"],
    ]);
    expect(input).toHaveAttribute("placeholder", `${vm.name}:/home/guest$ Enter command...`);
    expect(screen.getByText(/No such directory/)).toBeTruthy();
  });

  it("ignores a command result from a closed shell and prevents duplicate submissions", async () => {
    const shell = deferredStart();
    vi.mocked(limaApi.list).mockResolvedValue([{ ...vm, status: "Running" }]);
    vi.mocked(limaApi.shell).mockReturnValue(shell.pending);
    render(LinuxVMs);
    await fireEvent.click(await screen.findByText(vm.name));

    const input = screen.getByRole("textbox");
    await fireEvent.input(input, { target: { value: "cd /tmp" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    await fireEvent.input(input, { target: { value: "pwd" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(limaApi.shell).toHaveBeenCalledExactlyOnceWith(vm.name, "pwd -P", "/tmp");

    await fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    await fireEvent.click(screen.getByText(vm.name));
    shell.complete("/tmp\n");
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveAttribute(
      "placeholder", `${vm.name}:/$ Enter command...`,
    ));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
});
