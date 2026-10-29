// Mutex por clave en proceso: las tareas de una misma clave corren en orden, las de claves
// distintas en paralelo. Un fallo no bloquea a las siguientes.
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task);
    const settled = next.catch(() => {});
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return next;
  }
}
