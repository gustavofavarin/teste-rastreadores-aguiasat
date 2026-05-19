import {
  getSnapshotInfo as getGetrakSnapshotInfo,
} from '../server/getrak.js';
import {
  getSnapshotInfo as getDoSnapshotInfo,
} from '../server/dotelematics.js';

export default function handler(_req, res) {
  res.status(200).json({
    ok: true,
    snapshots: {
      getrak: getGetrakSnapshotInfo(),
      dotelematics: getDoSnapshotInfo(),
    },
  });
}
