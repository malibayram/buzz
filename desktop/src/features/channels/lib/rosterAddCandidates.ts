import { canonicalNpub, normalizePubkey } from "@/shared/lib/pubkey";
import { parsePubkeyInput } from "@/shared/lib/nostrUtils";

const HEX_FRAGMENT_REGEX = /^[0-9a-f]+$/;

/**
 * Pubkeys the add-member picker should offer for `query` beyond profile search.
 *
 * Profile search only finds identities with a kind:0 event, so a member who
 * joined without publishing one (shown everywhere as their raw key) would be
 * impossible to add. This matches the community roster by key instead: a
 * pasted npub or 64-char hex is offered as-is, and a hex or npub prefix of at
 * least `minQueryLength` characters matches roster members.
 */
export function rosterAddCandidatePubkeys({
  minQueryLength,
  query,
  rosterPubkeys,
}: {
  minQueryLength: number;
  query: string;
  rosterPubkeys: readonly string[];
}): string[] {
  const exact = parsePubkeyInput(query);
  if (exact !== null) {
    return [exact];
  }

  const fragment = query.trim().toLowerCase();
  if (fragment.length < minQueryLength) {
    return [];
  }
  const isHex = HEX_FRAGMENT_REGEX.test(fragment);
  const isNpub = fragment.startsWith("npub1");
  if (!isHex && !isNpub) {
    return [];
  }

  return rosterPubkeys
    .map(normalizePubkey)
    .filter((pubkey) =>
      isHex
        ? pubkey.startsWith(fragment)
        : (canonicalNpub(pubkey)?.startsWith(fragment) ?? false),
    );
}
