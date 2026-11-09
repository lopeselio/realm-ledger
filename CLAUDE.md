# Realm Ledger — agent notes

- Hackathon rules: https://nearhackathon.com/HACKATHON.md (deadline 2026-11-14 23:59 UTC; repo must stay public; hosted demo up to 2026-11-18, ideally 2026-11-25).
- Design source of truth: DESIGN.md. Keep README "do X, see Y" steps current — AI judges run them.
- Independent of Bazaar of Liars (../near-hack): no copied code; each README names the other (Q-015). Not a port of ../cryptara-conquest.
- Testnet only. Keys live in .env / ~/.near-credentials, never in the repo.
- The LLM never decides orders, battles or prices; packages/rules does.
- Verify NEAR endpoints/SDK versions against docs.near.org/llms.txt and docs.near.ai/llms.txt, not memory.
- 3D assets: bpy scripts in tools/blender, run headless with /Applications/Blender.app/Contents/MacOS/Blender -b -P <script>; render a PNG preview and review it. No paid or AI-generated asset packs.
- Every change: branch → PR → code review (re-review fixes until clean) → `gh pr merge --rebase --delete-branch`, so granular commits survive. No AI attribution: no Co-Authored-By lines in commits, nothing like "Generated with Claude Code" in PR bodies.
- GitHub repo lopeselio/realm-ledger must be created by the user (`gh repo create lopeselio/realm-ledger --public --source . --push`); creating public repos is blocked for the agent.
