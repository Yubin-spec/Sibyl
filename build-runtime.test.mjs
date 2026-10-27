import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

test('macOS build rejects a Node runtime with external dylibs before creating the App',t=>{
 if(process.platform!=='darwin'||!existsSync('/opt/homebrew/bin/node'))return t.skip('Requires a Homebrew Node fixture on macOS');
 const libraries=spawnSync('/usr/bin/otool',['-L','/opt/homebrew/bin/node'],{encoding:'utf8'});
 if(!/\n\s+(?:@rpath|\/opt\/homebrew)/.test(libraries.stdout))return t.skip('Installed Node has no external dylib dependency');
 const dir=mkdtempSync(join(tmpdir(),'bridge-build-runtime-')),app=join(dir,'AI Bridge.app');
 try{
  const result=spawnSync('/bin/zsh',[fileURLToPath(new URL('./build-app.sh',import.meta.url)),app,'/opt/homebrew/bin/node'],{encoding:'utf8',timeout:30000});
  assert.notEqual(result.status,0,'must reject a runtime that will fail after relocation');
  assert.match(result.stderr,/external dylibs/);
  assert.equal(existsSync(app),false,'must reject before modifying the build output');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
