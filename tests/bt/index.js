/*
 * `node --test tests/bt` 진입점.
 * Node 22 이상은 --test 뒤의 폴더 이름을 파일(모듈)로 해석하므로, 이 파일이 폴더 안의 *.test.js 를 모두 불러온다.
 * (파일 하나만 돌리려면: node --test tests/bt/engine.test.js)
 */
'use strict';
const fs = require('fs');
const path = require('path');
fs.readdirSync(__dirname).filter(function (f) { return /\.test\.js$/.test(f); }).sort().forEach(function (f) { require(path.join(__dirname, f)); });
