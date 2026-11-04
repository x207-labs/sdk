// The guards of the write tools (SD-082, spec 6.4). Each guard is a plain function of the configuration and the state of the session, so each can be tested alone.
import type { CircleViewFn } from "@x207/core";
import { ToolError } from "./tools.js";
import type { WriteConfig } from "./write-config.js";

export type NearKeyKind = "none" | "function-call" | "full-access" | "unknown";

export class Guards {
  #spent = 0n;
  constructor(readonly cfg: WriteConfig, private readonly view: CircleViewFn) {}

  /** Total committed in this session (credit units). */
  get spent(): bigint {
    return this.#spent;
  }
  get remaining(): bigint {
    return this.cfg.maxSpendSession - this.#spent;
  }

  /** Guard 2: the price of ONE payment, offer or milestone. */
  price(amount: bigint, what: string): void {
    if (amount < 0n) throw new ToolError(`refused: ${what} is negative`); // cross review UM-112, F4
    if (amount > this.cfg.maxPricePerCall) throw new ToolError(`refused: ${what} of ${amount} is above X207_MAX_PRICE_PER_CALL (${this.cfg.maxPricePerCall}); the price the seller names is not trusted`);
  }

  /** Guard 1: the budget of the session. Adds `amount` when it fits; call it right before the commitment is signed. */
  spend(amount: bigint, what: string): void {
    if (amount < 0n) throw new ToolError(`refused: ${what} is negative`);
    if (this.#spent + amount > this.cfg.maxSpendSession) {
      throw new ToolError(`refused: ${what} of ${amount} would take this session to ${this.#spent + amount}, above X207_MAX_SPEND_SESSION (${this.cfg.maxSpendSession}); ${this.remaining} left`);
    }
    this.#spent += amount;
  }

  /** Gives back what `spend` took when the commitment was not made after all. */
  release(amount: bigint): void {
    if (amount < 0n) return;
    this.#spent = this.#spent >= amount ? this.#spent - amount : 0n;
  }

  /** Guard 4: only an ACTIVE member of the circle, and, when the operator wrote a list, only a member of that list. Never the agent itself. */
  async counterparty(account: string): Promise<void> {
    if (account === this.cfg.account) throw new ToolError("refused: the agent cannot deal with itself");
    const list = this.cfg.allowedCounterparties;
    if (list.length > 0 && !list.includes(account)) throw new ToolError(`refused: ${account} is not in X207_ALLOWED_COUNTERPARTIES`);
    const member = (await this.view("member", { account_id: account })) as { status?: string } | null;
    if (member === null || member.status !== "active") throw new ToolError(`refused: ${account} is not an active member of the circle`);
  }

  /** Guard 3: tools that move USDT or NEAR out of the agent into the circle stay off unless the operator turns them on. */
  outflows(tool: string): void {
    if (!this.cfg.allowOutflows) throw new ToolError(`refused: ${tool} moves funds out of the agent account; set X207_ALLOW_OUTFLOWS=1 to allow it`);
  }

  /** Guard 5: what the NEAR key may do. A function-call key cannot attach a deposit, so no tool that sends one can run with it. */
  nearKey(kind: NearKeyKind, tool: string): void {
    if (this.cfg.nearKey === null) throw new ToolError(`refused: ${tool} sends a transaction and needs X207_AGENT_NEAR_KEY`);
    if (kind === "function-call") throw new ToolError(`refused: the NEAR key is a function-call key, which cannot attach the deposit that ${tool} needs; no transaction was sent`);
    if (kind === "full-access" && !this.cfg.allowFullAccessKey) throw new ToolError(`refused: the NEAR key has full access to the account; set X207_ALLOW_FULL_ACCESS_KEY=1 to use it for ${tool}`);
    if (kind !== "full-access") throw new ToolError(`refused: the NEAR key is not a key of ${this.cfg.account}; no transaction was sent`);
  }
}
