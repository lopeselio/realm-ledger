#!/usr/bin/env bash
# End-to-end check of the deployed realm contract on testnet.
#   contracts/realm/scripts/smoke-testnet.sh [contract-account] [referee-account]
#
# What it does:
#  1. creates two agent accounts (sub-accounts of the contract) whose ONLY key is a
#     function-call key limited to the contract's agent methods,
#  2. runs a one-season campaign through them: seal, reveal (checked against the seal),
#     settle, a spy hired by a ruler with escrow and a receipt, final reveal of the
#     roll secret and agendas (checked against their commitments),
#  3. shows an agent cannot move NEAR (its key can't sign a transfer).
# Needs: near CLI (near-cli-rs), node, and the owner's and referee's keys in ~/.near-credentials.
set -euo pipefail
# note: checks pipe near CLI output into grep without -q, so grep reads everything
# (grep -q exits early, the CLI gets SIGPIPE, and pipefail reports a false failure)

CONTRACT="${1:-realm-ledger.testnet}"
# the game server's account: settles seasons and finishes campaigns
REFEREE="${2:-realm-ledger-ops.testnet}"
NET="network-config testnet"
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="$(date +%s)"
# agents persist between runs (an agent can never hand its NEAR back, by design)
R0="smoke-r0.${CONTRACT}"
R1="smoke-r1.${CONTRACT}"
SPY="smoke-spy.${CONTRACT}"

sha() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }
# near CLI exits non-zero when a contract panics; we judge each call by its output instead
call() { # account method json [deposit]
  near contract call-function as-transaction "$CONTRACT" "$2" json-args "$3" prepaid-gas '30 Tgas' \
    attached-deposit "${4:-0 NEAR}" sign-as "$1" $NET sign-with-legacy-keychain send 2>&1 || true
}
# the integer a call returned, from near CLI's output on stdin
retval() { grep -A1 "Function execution return value" | tail -1 | grep -Eo '^[0-9]+' || true; }
# read-only call; prints only the return value
view() { near contract call-function as-read-only "$CONTRACT" "$1" json-args "$2" $NET now 2>/dev/null; }
exists() { near account view-account-summary "$1" $NET now 2>&1 | grep "Native account balance" >/dev/null; }
# reads a call's output on stdin; passes only if the transaction succeeded, else shows why and stops
expect_ok() { local out; out="$(cat)"; if grep -q "succeeded\." <<<"$out"; then ok "$1"; else echo "FAILED: $1"; grep -E "Error|panicked|Smart contract" <<<"$out" | head -3; exit 1; fi; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

step "1. agent accounts with function-call keys only"
call "$CONTRACT" add_referee "{\"account\":\"$REFEREE\"}" | expect_ok "$REFEREE is a referee"
for A in "$R0" "$R1" "$SPY"; do
  if exists "$A"; then ok "$A (exists)"; continue; fi
  PK="$(node "$HERE/keygen.mjs" "$A")"
  NAME="${A%%.*}"
  call "$CONTRACT" create_agent "{\"name\":\"$NAME\",\"public_key\":\"$PK\"}" '0.2 NEAR' | expect_ok "created $A"
  exists "$A" || { echo "$A was not created"; exit 1; }
done
KEYS="$(near account list-keys "$R0" $NET now 2>&1 | grep -E '^\| [0-9]' || true)"
printf '%s\n' "$KEYS" | grep -o 'only do .*' | sed 's/ *|$//; s/^/  key: /'
[ "$(printf '%s\n' "$KEYS" | grep -c '^| ')" = 1 ] && ! printf '%s' "$KEYS" | grep -q 'full access' && ok "one key per agent, function-call only"

step "2. campaign: commitments for the roll secret and agendas"
ROLL='"smoke-roll"'; ROLL_SALT="rs-$RUN"
A0='{"kind":"covet","text":"wants the iron hills"}'; A1='{"kind":"vendetta","text":"owes a blood debt"}'
AS0="as0-$RUN"; AS1="as1-$RUN"
OUT="$(call "$REFEREE" create_campaign "{\"realms\":[
  {\"ruler\":\"$R0\",\"chancellor\":null,\"treasury\":300,\"season_cap\":100,\"campaign_cap\":200},
  {\"ruler\":\"$R1\",\"chancellor\":null,\"treasury\":300,\"season_cap\":100,\"campaign_cap\":200}],
  \"map_seed\":\"smoke-$RUN\",\"roll_commit\":\"$(sha "$ROLL|$ROLL_SALT")\",
  \"agenda_commits\":[\"$(sha "$A0|$AS0")\",\"$(sha "$A1|$AS1")\"],\"max_seasons\":1,\"season_ms\":600000}")"
ID="$(printf '%s' "$OUT" | retval)"
[ -n "$ID" ] || { echo "$OUT"; exit 1; }
ok "campaign $ID"

step "3. seal (signed by each agent's function-call key)"
O0='{"orders":[{"from":3,"kind":"march","to":4}],"realm":0,"season":0}'; S0="s0-$RUN"
O1='{"orders":[{"good":"iron","kind":"trade","qty":2,"side":"buy"}],"realm":1,"season":0}'; S1="s1-$RUN"
call "$R0" seal "{\"campaign\":$ID,\"realm\":0,\"seal\":\"$(sha "$O0|$S0")\"}" | expect_ok "realm 0 sealed"
call "$R1" seal "{\"campaign\":$ID,\"realm\":1,\"seal\":\"$(sha "$O1|$S1")\"}" | expect_ok "realm 1 sealed"

step "4. reveal: a tampered reveal is refused, the true one is accepted"
BAD="$(printf '%s' "$O0" | sed 's/"to":4/"to":5/')"
[ "$BAD" != "$O0" ] || { echo "test bug: tampered orders equal the real ones"; exit 1; }
if call "$R0" reveal "$(node -e 'console.log(JSON.stringify({campaign:+process.argv[1],realm:0,orders:process.argv[2],salt:process.argv[3]}))' "$ID" "$BAD" "$S0")" | grep "orders do not match the seal" >/dev/null; then ok "tampered orders refused"; else echo "tampered reveal was not refused"; exit 1; fi
for i in 0 1; do
  O="O$i"; S="S$i"; R="R$i"
  call "${!R}" reveal "$(node -e 'console.log(JSON.stringify({campaign:+process.argv[1],realm:+process.argv[2],orders:process.argv[3],salt:process.argv[4]}))' "$ID" "$i" "${!O}" "${!S}")" | expect_ok "realm $i revealed"
done

step "5. agent economy: ruler 1 hires a spy; escrow, delivery, payment, receipt"
OUT="$(call "$R1" hire "{\"campaign\":$ID,\"realm\":1,\"worker\":\"$SPY\",\"kind\":\"Spy\",\"price\":40,\"spec\":\"watch the Ember Pass\"}")"
JOB="$(printf '%s' "$OUT" | retval)"
ok "job $JOB in escrow"
if call "$R1" hire "{\"campaign\":$ID,\"realm\":1,\"worker\":\"$SPY\",\"kind\":\"Spy\",\"price\":70,\"spec\":\"too much\"}" | grep "over this season's spending cap" >/dev/null; then ok "spend over the policy cap refused"; else echo "cap not enforced"; exit 1; fi
call "$SPY" deliver "{\"job\":$JOB,\"delivery\":\"$(sha "report: 3 regulars at the pass")\"}" | expect_ok "spy delivered"
call "$R1" settle_job "{\"job\":$JOB,\"passed\":true,\"note\":\"matched the reveal\"}" | grep -E "EVENT_JSON" | head -1 | sed 's/^.*EVENT_JSON:/  receipt: /' | cut -c1-200
printf '  spy earnings: '; view get_earnings "{\"campaign\":$ID,\"worker\":\"$SPY\"}"

step "6. settle the season and finish: roll secret and agendas checked against commitments"
call "$REFEREE" settle_season "{\"campaign\":$ID,\"state_hash\":\"$(sha "state-after-season-0")\",\"treasury_deltas\":[12,-5],\"fallen\":[],\"broken_treaties\":[]}" | expect_ok "season settled"
call "$REFEREE" finish_campaign "$(node -e 'const [id,roll,rs,a0,s0,a1,s1]=process.argv.slice(1);console.log(JSON.stringify({campaign:+id,winner:0,roll_secret:roll,roll_salt:rs,agendas:[[a0,s0],[a1,s1]]}))' "$ID" "$ROLL" "$ROLL_SALT" "$A0" "$AS0" "$A1" "$AS1")" | expect_ok "campaign finished"
view get_campaign "{\"campaign\":$ID}" | grep -E '"(phase|winner|treasury|season)"' | tr -s ' '

step "7. an agent cannot move NEAR"
if { near tokens "$R0" send-near "$CONTRACT" '0.01 NEAR' $NET sign-with-legacy-keychain send 2>&1 || true; } | grep "requires a full permission access key" >/dev/null; then ok "transfer refused: the agent only holds a function-call key"; else echo "transfer was NOT refused"; exit 1; fi

printf '\n\033[32mall checks passed\033[0m (campaign %s on %s)\n' "$ID" "$CONTRACT"
