import { describe, expect, it } from "vitest";
import { installCommand, packageManager } from "./doctor.ts";

describe("doctor's install hints are this system's", () => {
  it("finds the package manager and names its command and package", () => {
    expect(packageManager((c) => c === "apt-get")).toBe("apt");
    expect(packageManager((c) => c === "pacman")).toBe("pacman");
    expect(packageManager(() => false)).toBeNull();
    expect(installCommand("apt", "libnotify")).toBe("sudo apt install libnotify-bin");
    expect(installCommand("pacman", "libnotify")).toBe("sudo pacman -S libnotify");
    expect(installCommand("dnf", "bubblewrap")).toBe("sudo dnf install bubblewrap");
    expect(installCommand("zypper", "libnotify")).toBe("sudo zypper install libnotify-tools");
    expect(installCommand("apk", "git")).toBe("sudo apk add git");
    expect(installCommand(null, "git")).toBe("install git with your package manager");
  });
});
