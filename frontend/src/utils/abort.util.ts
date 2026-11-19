/**
 * Espera `ms`, mas rejeita com AbortError imediatamente se o sinal for
 * abortado. Usado nos backs-off de retry do upload para que cancelar não
 * deixe o estado de "carregando" preso por 5 segundos.
 */
export const waitWithAbort = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
