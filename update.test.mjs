import test from 'node:test';
import assert from 'node:assert/strict';
import {newerVersion,pickInstaller,trustedAsset,updateInfo} from './update.mjs';

test('version comparison follows numeric segments',()=>{
  assert.equal(newerVersion('0.3.1','0.3.0'),true);
  assert.equal(newerVersion('v0.3.0','0.3.0'),false);
  assert.equal(newerVersion('0.4','0.10.2'),false);
  assert.equal(newerVersion('1.0.0','0.9.9'),true);
});

test('only trusted GitHub DMG assets are offered for download',()=>{
  const release={tag_name:'v0.3.1',assets:[
    {name:'notes.txt',browser_download_url:'https://github.com/x/y/releases/download/v0.3.1/notes.txt',size:1},
    {name:'AI-Bridge-0.3.1-arm64.dmg',browser_download_url:'https://github.com/x/y/releases/download/v0.3.1/AI-Bridge-0.3.1-arm64.dmg',size:10},
    {name:'evil.dmg',browser_download_url:'https://example.com/evil.dmg',size:10}
  ]};
  assert.equal(pickInstaller(release).name,'AI-Bridge-0.3.1-arm64.dmg');
  assert.equal(trustedAsset('http://github.com/x.dmg'),false);
  assert.equal(trustedAsset('https://objects.githubusercontent.com/x.dmg'),true);
  const info=updateInfo('0.3.0',release);
  assert.equal(info.available,true);
  assert.equal(info.latest,'0.3.1');
});
