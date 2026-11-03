// The view `get_proposal(epoch, from_index, limit)` of interface 0.0.13 (CT-099): the edges of the clearing proposal that is not committed yet, in pages. The event `clearing_applied`
// has no edges any more (only `edge_count` and `edges_hash`), so a solver or an indexer that needs them reads this view; after the commit the edges are read from `list_obligations`
// (the field `cleared` does not change after the commit).
import { edgesHash } from "../clearing-hash.js";
import type { CircleViewFn } from "./client.js";
import type { ProposalView } from "./types.generated.js";

/** One page of the view `get_proposal` (`ProposalView` of the ABI 0.0.13). `edges` are in the order of the contract; `edge_count` is the count of the whole proposal; `committed` says that the epoch is already committed. */
export type ProposalPage = ProposalView;

export const PROPOSAL_PAGE_LIMIT = 50;

/** `get_proposal` for one page; `null` when there is no proposal for the epoch (nothing submitted, or already committed). */
export async function getProposalPage(view: CircleViewFn, epoch: number, fromIndex: number, limit: number = PROPOSAL_PAGE_LIMIT): Promise<ProposalPage | null> {
  const page = (await view("get_proposal", { epoch, from_index: fromIndex, limit })) as ProposalPage | null;
  return page;
}

/**
 * All the edges of the proposal of an epoch, page by page, and the check against `edges_hash` of the event `clearing_applied` when it is given: the edges that the view answered must
 * hash to it, otherwise `Error` (a lying or stale RPC node). `null` when there is no proposal.
 */
export async function readProposal(view: CircleViewFn, epoch: number, options: { pageLimit?: number; expectedEdgesHash?: string } = {}): Promise<ProposalPage | null> {
  const limit = options.pageLimit ?? PROPOSAL_PAGE_LIMIT;
  const first = await getProposalPage(view, epoch, 0, limit);
  if (first === null) return null;
  const edges = [...first.edges];
  while (edges.length < first.edge_count) {
    const next = await getProposalPage(view, epoch, edges.length, limit);
    if (next === null || next.edges.length === 0) throw new Error(`get_proposal: the proposal of epoch ${epoch} ended at ${edges.length} of ${first.edge_count} edges`);
    edges.push(...next.edges);
  }
  if (options.expectedEdgesHash !== undefined && edgesHash(edges) !== options.expectedEdgesHash) {
    throw new Error(`get_proposal: the edges of epoch ${epoch} do not hash to the edges_hash of the event (${options.expectedEdgesHash})`);
  }
  return { ...first, edges };
}
