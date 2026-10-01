/**
 * A testing seam for the fault-injection suite: when ORAKNID_FAULT names
 * this point, the process kills itself with SIGKILL right here, the way a
 * power cut would. It does nothing otherwise.
 */
const target = process.env.ORAKNID_FAULT;

export function faultPoint(name: string): void {
  if (target !== undefined && target === name) process.kill(process.pid, "SIGKILL");
}
