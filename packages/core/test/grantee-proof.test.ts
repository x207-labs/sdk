import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
  GranteeProofError, buildGistContent, encodeGranteeProof, generateVoucherKeypair, granteeChallenge, parseGranteeProof, parseSshEd25519, signSshChallenge, sshEd25519Line,
  verifyNearGistProof, verifyOAuthProof, verifySshProof, type ChallengeInput,
} from "../src/index.js";

const CIRCLE = "x207-circle.near";
const challenge: ChallengeInput = { circle: CIRCLE, grantId: 12, granteeRef: "octocat", nonce: "nonce-12345678" };
const renter = generateVoucherKeypair();
const code = async (fn: () => unknown): Promise<string> => {
  try {
    await fn();
    return "no error";
  } catch (e) {
    return e instanceof GranteeProofError ? e.code : `other: ${String(e)}`;
  }
};

describe("SD-071 proof of the grantee_ref", () => {
  it("TC-SD-071-01 the challenge binds circle, grant, reference and nonce; a bad grant id, nonce or reference is refused", async () => {
    expect(granteeChallenge(challenge)).toBe("x207-grantee-proof v1\ncircle=x207-circle.near\ngrant=12\nref=octocat\nnonce=nonce-12345678");
    expect(granteeChallenge({ ...challenge, grantId: 13 })).not.toBe(granteeChallenge(challenge));
    for (const bad of [{ grantId: 0 }, { nonce: "short" }, { granteeRef: "" }, { granteeRef: "a\nb" }]) expect(await code(() => granteeChallenge({ ...challenge, ...bad })), JSON.stringify(bad)).toBe("grantee_proof_wrong_challenge");
  });

  it("TC-SD-071-02 the proof is encoded to text and parsed back; an unknown kind, a bad field or a proof above 2048 bytes is refused", async () => {
    for (const proof of [{ kind: "near-gist", gist: "octocat/abc123" }, { kind: "ssh-signature", signature: "A".repeat(88) }, { kind: "oauth", provider: "github", token: "short-lived" }] as const) {
      expect(parseGranteeProof(encodeGranteeProof(proof))).toEqual(proof);
    }
    for (const bad of ['{"kind":"password","value":"x"}', "not json", '{"kind":"near-gist","gist":"has space"}', '{"kind":"ssh-signature","signature":"short"}', '{"kind":"oauth","provider":"GitHub","token":"t"}', JSON.stringify({ kind: "oauth", provider: "github", token: "x".repeat(3000) })]) {
      expect(await code(() => parseGranteeProof(bad)), bad.slice(0, 40)).toBe("grantee_proof_bad_format");
    }
    expect(await code(() => encodeGranteeProof({ kind: "oauth", provider: "github", token: "x".repeat(2100) }))).toBe("grantee_proof_bad_format");
  });

  it("TC-SD-071-03 near-gist: the owner of the gist is the grantee_ref and a file holds the challenge signed by the voucher key of the renter; a wrong owner, challenge or key is refused", async () => {
    const content = buildGistContent(challenge, "renter.x207-circle.near", renter.secretKey);
    const proof = { kind: "near-gist" as const, gist: "octocat/abc123" };
    const fetchGist = async () => ({ owner: "Octocat", files: ["notes", content] });
    expect(await verifyNearGistProof({ proof, challenge, voucherPublicKey: renter.publicKey, fetchGist })).toBe(true);
    expect(await code(() => verifyNearGistProof({ proof, challenge, voucherPublicKey: renter.publicKey, fetchGist: async () => ({ owner: "hubot", files: [content] }) }))).toBe("grantee_proof_owner_mismatch");
    expect(await code(() => verifyNearGistProof({ proof, challenge: { ...challenge, grantId: 13 }, voucherPublicKey: renter.publicKey, fetchGist }))).toBe("grantee_proof_wrong_challenge");
    expect(await code(() => verifyNearGistProof({ proof, challenge, voucherPublicKey: generateVoucherKeypair().publicKey, fetchGist }))).toBe("grantee_proof_bad_signature");
    expect(await code(() => verifyNearGistProof({ proof, challenge, voucherPublicKey: renter.publicKey, fetchGist: async () => ({ owner: "octocat", files: [] }) }))).toBe("grantee_proof_wrong_challenge");
    expect(await code(() => verifyNearGistProof({ proof, challenge, voucherPublicKey: renter.publicKey, fetchGist: async () => { throw new Error("404"); } }))).toBe("grantee_proof_unverifiable");
    expect(await code(() => verifyNearGistProof({ proof: { kind: "oauth", provider: "x", token: "t" }, challenge, voucherPublicKey: renter.publicKey, fetchGist }))).toBe("grantee_proof_bad_format");
  });

  it("TC-SD-071-04 ssh-signature: the grantee_ref is an OpenSSH ed25519 key, the proof is the signature of the challenge by its private key; another key, another grant or another reference is refused", async () => {
    const seed = new Uint8Array(32).fill(4);
    const ref = sshEd25519Line(ed25519.getPublicKey(seed), "renter@laptop");
    expect(parseSshEd25519(ref)).toEqual(ed25519.getPublicKey(seed));
    const c = { ...challenge, granteeRef: ref };
    const proof = signSshChallenge(c, seed);
    expect(verifySshProof(proof, c)).toBe(true);
    expect(parseGranteeProof(encodeGranteeProof(proof))).toEqual(proof);
    expect(await code(() => verifySshProof(proof, { ...c, grantId: 13 }))).toBe("grantee_proof_bad_signature");
    expect(await code(() => verifySshProof(proof, { ...c, granteeRef: sshEd25519Line(ed25519.getPublicKey(new Uint8Array(32).fill(5))) }))).toBe("grantee_proof_bad_signature");
    for (const bad of ["ssh-rsa AAAAB3NzaC1yc2E", "ssh-ed25519 !!!", "ssh-ed25519 AAAA"]) expect(await code(() => parseSshEd25519(bad)), bad).toBe("grantee_proof_bad_format");
    expect(await code(() => signSshChallenge(c, new Uint8Array(31)))).toBe("grantee_proof_bad_format");
  });

  it("TC-SD-071-05 oauth: the subject that the provider returns must be the grantee_ref; a provider that fails is unverifiable", async () => {
    const proof = { kind: "oauth" as const, provider: "github", token: "t-123" };
    expect(await verifyOAuthProof(proof, "octocat", async () => ({ subject: "octocat" }))).toBe(true);
    expect(await code(() => verifyOAuthProof(proof, "octocat", async () => ({ subject: "hubot" })))).toBe("grantee_proof_owner_mismatch");
    expect(await code(() => verifyOAuthProof(proof, "octocat", async () => { throw new Error("401"); }))).toBe("grantee_proof_unverifiable");
    expect(await code(() => verifyOAuthProof({ kind: "near-gist", gist: "a/b" }, "octocat", async () => ({ subject: "octocat" })))).toBe("grantee_proof_bad_format");
  });
});
