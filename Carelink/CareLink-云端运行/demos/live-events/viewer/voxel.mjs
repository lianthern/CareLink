const SOLID = 0xff000000 >>> 0;

function popcount(n) {
  n >>>= 0;
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export async function loadVoxel(jsonUrl, binUrl) {
  const meta = await (await fetch(jsonUrl)).json();
  if (!binUrl) {
    binUrl = jsonUrl.replace(/\.voxel\.json(\?.*)?$/, ".voxel.bin$1").replace(/\.json(\?.*)?$/, ".bin$1");
  }
  const buffer = await (await fetch(binUrl)).arrayBuffer();
  const view = new Uint32Array(buffer);
  return new VoxelGrid(meta, view.subarray(0, meta.nodeCount), view.subarray(meta.nodeCount, meta.nodeCount + meta.leafDataCount));
}

class VoxelGrid {
  constructor(meta, nodes, leafData) {
    this.res = meta.voxelResolution;
    this.minX = meta.gridBounds.min[0];
    this.minY = meta.gridBounds.min[1];
    this.minZ = meta.gridBounds.min[2];
    this.nx = Math.round((meta.gridBounds.max[0] - meta.gridBounds.min[0]) / this.res);
    this.ny = Math.round((meta.gridBounds.max[1] - meta.gridBounds.min[1]) / this.res);
    this.nz = Math.round((meta.gridBounds.max[2] - meta.gridBounds.min[2]) / this.res);
    this.leaf = meta.leafSize;
    this.depth = meta.treeDepth;
    this.nodes = nodes;
    this.leafData = leafData;
    this.radius = Math.max(this.res * 2.4, 0.12);
  }

  isSolidIndex(ix, iy, iz) {
    if (!this.nodes.length || ix < 0 || iy < 0 || iz < 0 || ix >= this.nx || iy >= this.ny || iz >= this.nz) return false;
    const bx = Math.floor(ix / this.leaf);
    const by = Math.floor(iy / this.leaf);
    const bz = Math.floor(iz / this.leaf);
    let nodeIndex = 0;
    for (let level = this.depth - 1; level >= 0; level--) {
      const node = this.nodes[nodeIndex] >>> 0;
      if (node === SOLID) return true;
      const childMask = (node >>> 24) & 0xff;
      if (childMask === 0) return this.leafBit(node, ix, iy, iz);
      const octant = (((bz >>> level) & 1) << 2) | (((by >>> level) & 1) << 1) | ((bx >>> level) & 1);
      if ((childMask & (1 << octant)) === 0) return false;
      nodeIndex = (node & 0xffffff) + popcount(childMask & ((1 << octant) - 1));
    }
    const node = this.nodes[nodeIndex] >>> 0;
    if (node === SOLID) return true;
    return this.leafBit(node, ix, iy, iz);
  }

  leafBit(node, ix, iy, iz) {
    const bit = (iz & 3) * 16 + (iy & 3) * 4 + (ix & 3);
    const word = this.leafData[((node & 0xffffff) * 2) + (bit < 32 ? 0 : 1)] >>> 0;
    return ((word >>> (bit < 32 ? bit : bit - 32)) & 1) === 1;
  }

  overlaps(x, y, z, radius = this.radius) {
    const res = this.res;
    const ix0 = Math.floor((x - radius - this.minX) / res);
    const iy0 = Math.floor((y - radius - this.minY) / res);
    const iz0 = Math.floor((z - radius - this.minZ) / res);
    const ix1 = Math.floor((x + radius - this.minX) / res);
    const iy1 = Math.floor((y + radius - this.minY) / res);
    const iz1 = Math.floor((z + radius - this.minZ) / res);
    const r2 = radius * radius;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          if (!this.isSolidIndex(ix, iy, iz)) continue;
          const minX = this.minX + ix * res;
          const minY = this.minY + iy * res;
          const minZ = this.minZ + iz * res;
          const nx = Math.max(minX, Math.min(x, minX + res)) - x;
          const ny = Math.max(minY, Math.min(y, minY + res)) - y;
          const nz = Math.max(minZ, Math.min(z, minZ + res)) - z;
          if (nx * nx + ny * ny + nz * nz < r2) return true;
        }
      }
    }
    return false;
  }

  constrainXZ(x, y, z, dx, dz) {
    const tx = x + dx;
    const tz = z + dz;
    if (!this.overlaps(tx, y, tz)) return [tx, y, tz];
    if (!this.overlaps(tx, y, z) && Math.abs(dx) >= Math.abs(dz)) return [tx, y, z];
    if (!this.overlaps(x, y, tz) && Math.abs(dz) >= Math.abs(dx)) return [x, y, tz];
    if (!this.overlaps(tx, y, z)) return [tx, y, z];
    if (!this.overlaps(x, y, tz)) return [x, y, tz];
    return [x, y, z];
  }
}
