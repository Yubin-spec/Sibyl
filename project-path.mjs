import {realpathSync,statSync} from 'node:fs';
import {resolve} from 'node:path';

// Identity key for a project directory. Never used as a filesystem path.
export function normalizedPath(value){
 let path=String(value).replace(/\\/g,'/');
 while(path.length>1&&path.endsWith('/'))path=path.slice(0,-1);
 return process.platform==='win32'?path.toLowerCase():path;
}

export function canonicalProjectPath(input){
 if(typeof input!=='string'||!input.trim()||input.length>1024)throw Error('Invalid project path');
 const real=realpathSync(resolve(input));
 if(!statSync(real).isDirectory())throw Error('Project path must be a directory');
 return real;
}

// null means the path cannot be trusted for automatic project routing.
export function projectKey(input){
 try{return normalizedPath(canonicalProjectPath(input));}catch{return null;}
}
