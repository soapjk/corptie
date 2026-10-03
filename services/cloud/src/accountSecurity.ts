export type AccountRevocationListener = (accountId: string) => void;

export class AccountRevocationEvents {
  private readonly listeners = new Set<AccountRevocationListener>();

  subscribe(listener: AccountRevocationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(accountId: string): void {
    for (const listener of this.listeners) listener(accountId);
  }
}
