# Plan: Prepare pi-context-timeline for public git repo + pi install

## Goal
Enable `pi install git:github.com/Danu28/pi-context-timeline` as a Pi package.

## Assumptions
- Repo name: pi-context-timeline (chosen)
- Package name: pi-context-timeline (keep)
- Pi package discovery: conventional extensions/ OR pi.extensions manifest
- Current dir: C:/Users/dhanu/Desktop/Pi-tools/context-timeline (not yet git)

## Steps
1. Update package.json: remove private, add license/repository/keywords/pi manifest/peerDeps
2. Create extensions/context-timeline.ts (canonical Pi package location) + keep root index.ts
3. Add .gitignore, LICENSE
4. Update README with pi install instructions
5. git init, add, commit, show remote instructions
6. Verify: tsc check + pi --extension loads

## Verification
- package.json has pi.extensions and pi-package keyword
- extensions/context-timeline.ts exists
- git log shows initial commit
- README contains pi install string
