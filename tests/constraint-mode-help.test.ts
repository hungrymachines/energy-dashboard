import { describe, expect, it } from 'vitest';
import { modeHelp } from '../src/ui/constraint-editor.js';

describe('modeHelp', () => {
  it('says Auto switches the thermostat, and that off stays off', () => {
    expect(modeHelp('auto')).toContain('switches your thermostat');
    expect(modeHelp('auto')).toContain('stays off');
  });

  it.each(['heat', 'cool'])('tells %s users to keep the thermostat matched', (mode) => {
    expect(modeHelp(mode)).toContain("thermostat's setting wins");
  });

  it('says Off leaves the thermostat alone', () => {
    expect(modeHelp('off')).toContain('leaves this thermostat alone');
  });
});
