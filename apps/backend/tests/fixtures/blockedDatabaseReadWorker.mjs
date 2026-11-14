import {parentPort} from 'node:worker_threads';
parentPort.postMessage({type:'ready'});
parentPort.on('message',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000));
