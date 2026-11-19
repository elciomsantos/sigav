import { describe, expect, it } from "vitest";
import { waitWithAbort } from "./abort.util";

describe("waitWithAbort (cancelamento do upload)", () => {
  it("resolve normalmente quando o prazo termina", async () => {
    const controller = new AbortController();
    await expect(waitWithAbort(10, controller.signal)).resolves.toBeUndefined();
  });

  it("rejeita com AbortError quando abortado durante a espera", async () => {
    const controller = new AbortController();
    const waiting = waitWithAbort(5000, controller.signal);

    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejeita imediatamente se o sinal já estava abortado", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(waitWithAbort(5000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
