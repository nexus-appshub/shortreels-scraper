import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaType, stableId } from '../src/utils.js';

test('detects HLS and DASH', () => {
  assert.equal(mediaType('https://cdn.example.com/master.m3u8'), 'hls');
  assert.equal(mediaType('https://cdn.example.com/manifest.mpd'), 'dash');
  assert.equal(mediaType('https://cdn.example.com/a.mp4'), 'mp4');
  assert.equal(mediaType('https://cdn.example.com/a.ts'), 'segment');
});

test('stable ids are deterministic', () => {
  assert.equal(stableId(['a', 'b']), stableId(['a', 'b']));
});