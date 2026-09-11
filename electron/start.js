'use strict';

// Launches the app with `electron .`, minus ELECTRON_RUN_AS_NODE. Terminals
// inside VS Code (itself an Electron app) can inherit that variable, which
// makes Electron behave like plain Node and the app fails to start.

const { spawn } = require('child_process');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], { cwd: __dirname, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
