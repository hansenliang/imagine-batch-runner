# Setup Instructions

## Prerequisites

You need Node.js installed to run this tool. Follow these steps:

### Install Node.js (macOS)

**Option 1: Using Homebrew (Recommended)**
```bash
# Install Homebrew if you don't have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js
brew install node
```

**Option 2: Using Official Installer**
1. Download from: https://nodejs.org/
2. Install the LTS version (recommended)

### Verify Installation

```bash
node --version   # Should show v18.x or higher
npm --version    # Should show v9.x or higher
```

## Install Project Dependencies

Once Node.js is installed, run:

```bash
cd "/Users/hansenliang/Projects/Imagine batch runner"
npm install
npx playwright install chromium
```

## First Run

Test the CLI:

```bash
npm start accounts list
```

You should see:
```
No accounts configured yet.
Use "grok-batch accounts:add <alias>" to add an account.
```

Now you're ready to add your first account and start generating videos!

Refer to [README.md](./README.md) for full usage instructions.
