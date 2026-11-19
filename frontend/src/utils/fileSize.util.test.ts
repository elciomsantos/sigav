import { describe, it, expect } from "vitest";
import { byteToHumanSizeString } from "./fileSize.util";

describe("byteToHumanSizeString", () => {
  it("returns 0 Byte for zero", () => {
    expect(byteToHumanSizeString(0)).toBe("0 Byte");
  });

  it("formats bytes, KB, MB, GB and TB", () => {
    expect(byteToHumanSizeString(1)).toBe("1.0 B");
    expect(byteToHumanSizeString(1500)).toBe("1.5 KB");
    expect(byteToHumanSizeString(1_000_000)).toBe("1.0 MB");
    expect(byteToHumanSizeString(1_000_000_000)).toBe("1.0 GB");
    expect(byteToHumanSizeString(1_000_000_000_000)).toBe("1.0 TB");
  });
});
