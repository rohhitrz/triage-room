export class RecoveryGate {
  private depth = 0;
  private barrier: Promise<void> = Promise.resolve();
  private open: (() => void) | null = null;

  get held(): boolean {
    return this.depth > 0;
  }

  hold(): void {
    this.depth += 1;
    if (this.depth === 1) {
      this.barrier = new Promise<void>((resolve) => {
        this.open = resolve;
      });
    }
  }

  release(): void {
    if (this.depth === 0) return;
    this.depth -= 1;
    if (this.depth === 0) {
      const open = this.open;
      this.open = null;
      open?.();
    }
  }

  async wait(): Promise<void> {
    while (this.depth > 0) await this.barrier;
  }
}
