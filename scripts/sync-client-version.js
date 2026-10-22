#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const spec = yaml.load(fs.readFileSync(path.join(ROOT, 'src/openapi.yaml'), 'utf8'));
const packagePath = path.join(ROOT, 'clients/typescript/package.json');
const clientPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

clientPackage.version = spec.info.version;
fs.writeFileSync(packagePath, `${JSON.stringify(clientPackage, null, 2)}\n`);
console.log(`[sync-client-version] Set TypeScript client version to ${clientPackage.version}`);
