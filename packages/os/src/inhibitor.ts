export interface InhibitorState {
  held: boolean;
  /** "block" normally; "delay" when the system refuses a blocking lock. */
  mode: "block" | "delay" | null;
  why: string | null;
  /** The last problem, in plain words (BR-17). */
  problem: string | null;
}

/** Keeps the machine awake while jobs are active (BR-11, ADR-012). */
export interface Inhibitor {
  acquire(why: string): Promise<InhibitorState>;
  release(): Promise<void>;
  state(): InhibitorState;
  onChange(listener: (state: InhibitorState) => void): () => void;
}
