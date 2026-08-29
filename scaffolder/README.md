# Taste scaffolder source

This directory is retained because career-ops uses it for agent-skill
entrypoints and updater compatibility. This derivative does not publish an npm
installer. Install it by cloning:

```bash
git clone https://github.com/srevilla55/career-ops-taste.git
cd career-ops-taste
npm install
```

The CLI source is retargeted to the Taste repository so any local use cannot
silently install the unsanitized upstream distribution.
