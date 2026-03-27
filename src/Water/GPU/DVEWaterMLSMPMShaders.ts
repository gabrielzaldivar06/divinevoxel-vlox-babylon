/**
 * WGSL compute shaders for GPU MLS-MPM fluid simulation.
 * Adapted from WebGPU-Ocean (CzzzzH/MLS-MPM and CzzzzH/WebGPU-Ocean).
 * Particle struct: position (vec3f, +pad), velocity (vec3f, +pad), C matrix (mat3x3f) = 80 bytes.
 * Cell struct:     vx, vy, vz, mass (i32 × 4) = 16 bytes.
 */

export const clearGridWGSL = /* wgsl */`
struct Cell {
    vx   : i32,
    vy   : i32,
    vz   : i32,
    mass : i32,
}

@group(0) @binding(0) var<storage, read_write> cells: array<Cell>;

@compute @workgroup_size(64)
fn clearGrid(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x < arrayLength(&cells)) {
        cells[id.x].mass = 0;
        cells[id.x].vx   = 0;
        cells[id.x].vy   = 0;
        cells[id.x].vz   = 0;
    }
}
`;

export const p2g1WGSL = /* wgsl */`
struct Particle {
    position : vec3f,
    _pad0    : f32,
    v        : vec3f,
    _pad1    : f32,
    C        : mat3x3f,
}

struct Cell {
    vx   : atomic<i32>,
    vy   : atomic<i32>,
    vz   : atomic<i32>,
    mass : atomic<i32>,
}

override fixed_point_multiplier : f32;

fn encodeFixedPoint(x: f32) -> i32 { return i32(x * fixed_point_multiplier); }

@group(0) @binding(0) var<storage, read>       particles : array<Particle>;
@group(0) @binding(1) var<storage, read_write> cells     : array<Cell>;
@group(0) @binding(2) var<uniform>             init_box_size : vec3f;

@compute @workgroup_size(64)
fn p2g_1(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= arrayLength(&particles)) { return; }

    let p = particles[id.x];
    let cell_idx  = floor(p.position);
    let cell_diff = p.position - (cell_idx + 0.5);

    var w: array<vec3f, 3>;
    w[0] = 0.5 * (0.5 - cell_diff) * (0.5 - cell_diff);
    w[1] = 0.75 - cell_diff * cell_diff;
    w[2] = 0.5 * (0.5 + cell_diff) * (0.5 + cell_diff);

    for (var gx = 0; gx < 3; gx++) {
        for (var gy = 0; gy < 3; gy++) {
            for (var gz = 0; gz < 3; gz++) {
                let weight = w[gx].x * w[gy].y * w[gz].z;
                let cx = cell_idx + vec3f(f32(gx) - 1., f32(gy) - 1., f32(gz) - 1.);
                let cell_dist = (cx + 0.5) - p.position;
                let Q = p.C * cell_dist;
                let mass_contrib = weight;
                let vel_contrib  = mass_contrib * (p.v + Q);
                let cidx = i32(cx.x) * i32(init_box_size.y) * i32(init_box_size.z)
                         + i32(cx.y) * i32(init_box_size.z)
                         + i32(cx.z);
                atomicAdd(&cells[cidx].mass, encodeFixedPoint(mass_contrib));
                atomicAdd(&cells[cidx].vx,   encodeFixedPoint(vel_contrib.x));
                atomicAdd(&cells[cidx].vy,   encodeFixedPoint(vel_contrib.y));
                atomicAdd(&cells[cidx].vz,   encodeFixedPoint(vel_contrib.z));
            }
        }
    }
}
`;

export const p2g2WGSL = /* wgsl */`
struct Particle {
    position : vec3f,
    _pad0    : f32,
    v        : vec3f,
    _pad1    : f32,
    C        : mat3x3f,
}

struct Cell {
    vx   : atomic<i32>,
    vy   : atomic<i32>,
    vz   : atomic<i32>,
    mass : i32,
}

override fixed_point_multiplier : f32;
override stiffness : f32;
override rest_density : f32;
override dynamic_viscosity : f32;
override dt : f32;

fn encodeFixedPoint(x: f32) -> i32 { return i32(x * fixed_point_multiplier); }
fn decodeFixedPoint(x: i32) -> f32 { return f32(x) / fixed_point_multiplier; }

@group(0) @binding(0) var<storage, read>       particles : array<Particle>;
@group(0) @binding(1) var<storage, read_write> cells     : array<Cell>;
@group(0) @binding(2) var<uniform>             init_box_size : vec3f;

@compute @workgroup_size(64)
fn p2g_2(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= arrayLength(&particles)) { return; }

    let p = particles[id.x];
    let cell_idx  = floor(p.position);
    let cell_diff = p.position - (cell_idx + 0.5);

    var w: array<vec3f, 3>;
    w[0] = 0.5 * (0.5 - cell_diff) * (0.5 - cell_diff);
    w[1] = 0.75 - cell_diff * cell_diff;
    w[2] = 0.5 * (0.5 + cell_diff) * (0.5 + cell_diff);

    var density = 0.0;
    for (var gx = 0; gx < 3; gx++) {
        for (var gy = 0; gy < 3; gy++) {
            for (var gz = 0; gz < 3; gz++) {
                let weight = w[gx].x * w[gy].y * w[gz].z;
                let cx = cell_idx + vec3f(f32(gx) - 1., f32(gy) - 1., f32(gz) - 1.);
                let cidx = i32(cx.x) * i32(init_box_size.y) * i32(init_box_size.z)
                         + i32(cx.y) * i32(init_box_size.z)
                         + i32(cx.z);
                density += decodeFixedPoint(cells[cidx].mass) * weight;
            }
        }
    }

    let volume   = 1.0 / density;
    let pressure = max(-0.0, stiffness * (pow(density / rest_density, 5.0) - 1.0));
    var stress = mat3x3f(-pressure, 0, 0, 0, -pressure, 0, 0, 0, -pressure);
    let strain = p.C + transpose(p.C);
    stress += dynamic_viscosity * strain;
    let eq16 = -volume * 4.0 * stress * dt;

    for (var gx = 0; gx < 3; gx++) {
        for (var gy = 0; gy < 3; gy++) {
            for (var gz = 0; gz < 3; gz++) {
                let weight = w[gx].x * w[gy].y * w[gz].z;
                let cx = cell_idx + vec3f(f32(gx) - 1., f32(gy) - 1., f32(gz) - 1.);
                let cell_dist = (cx + 0.5) - p.position;
                let cidx = i32(cx.x) * i32(init_box_size.y) * i32(init_box_size.z)
                         + i32(cx.y) * i32(init_box_size.z)
                         + i32(cx.z);
                let fterm = weight * (eq16 * cell_dist);
                atomicAdd(&cells[cidx].vx, encodeFixedPoint(fterm.x));
                atomicAdd(&cells[cidx].vy, encodeFixedPoint(fterm.y));
                atomicAdd(&cells[cidx].vz, encodeFixedPoint(fterm.z));
            }
        }
    }
}
`;

export const updateGridWGSL = /* wgsl */`
struct Cell {
    vx   : i32,
    vy   : i32,
    vz   : i32,
    mass : i32,
}

override fixed_point_multiplier : f32;
override dt : f32;
override gravity_y : f32;

fn encodeFixedPoint(x: f32) -> i32 { return i32(x * fixed_point_multiplier); }
fn decodeFixedPoint(x: i32) -> f32 { return f32(x) / fixed_point_multiplier; }

@group(0) @binding(0) var<storage, read_write> cells         : array<Cell>;
@group(0) @binding(1) var<uniform>             real_box_size : vec3f;
@group(0) @binding(2) var<uniform>             init_box_size : vec3f;

@compute @workgroup_size(64)
fn updateGrid(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= arrayLength(&cells)) { return; }
    if (cells[id.x].mass <= 0) { return; }

    var fv = vec3f(
        decodeFixedPoint(cells[id.x].vx),
        decodeFixedPoint(cells[id.x].vy),
        decodeFixedPoint(cells[id.x].vz)
    );
    fv /= decodeFixedPoint(cells[id.x].mass);
    fv.y += gravity_y * dt;

    cells[id.x].vx = encodeFixedPoint(fv.x);
    cells[id.x].vy = encodeFixedPoint(fv.y);
    cells[id.x].vz = encodeFixedPoint(fv.z);

    let ix = i32(id.x) / i32(init_box_size.z) / i32(init_box_size.y);
    let iy = (i32(id.x) / i32(init_box_size.z)) % i32(init_box_size.y);
    let iz = i32(id.x) % i32(init_box_size.z);

    if (ix < 2 || ix > i32(ceil(real_box_size.x) - 3)) { cells[id.x].vx = 0; }
    if (iy < 2 || iy > i32(ceil(real_box_size.y) - 3)) { cells[id.x].vy = 0; }
    if (iz < 2 || iz > i32(ceil(real_box_size.z) - 3)) { cells[id.x].vz = 0; }
}
`;

export const g2pWGSL = /* wgsl */`
struct Particle {
    position : vec3f,
    _pad0    : f32,
    v        : vec3f,
    _pad1    : f32,
    C        : mat3x3f,
}

struct Cell {
    vx   : i32,
    vy   : i32,
    vz   : i32,
    mass : i32,
}

override fixed_point_multiplier : f32;
override dt : f32;

fn decodeFixedPoint(x: i32) -> f32 { return f32(x) / fixed_point_multiplier; }

@group(0) @binding(0) var<storage, read_write> particles      : array<Particle>;
@group(0) @binding(1) var<storage, read>       cells          : array<Cell>;
@group(0) @binding(2) var<uniform>             real_box_size  : vec3f;
@group(0) @binding(3) var<uniform>             init_box_size  : vec3f;

@compute @workgroup_size(64)
fn g2p(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= arrayLength(&particles)) { return; }

    particles[id.x].v = vec3f(0.);

    let p = particles[id.x];
    let cell_idx  = floor(p.position);
    let cell_diff = p.position - (cell_idx + 0.5);

    var w: array<vec3f, 3>;
    w[0] = 0.5 * (0.5 - cell_diff) * (0.5 - cell_diff);
    w[1] = 0.75 - cell_diff * cell_diff;
    w[2] = 0.5 * (0.5 + cell_diff) * (0.5 + cell_diff);

    var B = mat3x3f(vec3f(0.), vec3f(0.), vec3f(0.));

    for (var gx = 0; gx < 3; gx++) {
        for (var gy = 0; gy < 3; gy++) {
            for (var gz = 0; gz < 3; gz++) {
                let weight = w[gx].x * w[gy].y * w[gz].z;
                let cx = cell_idx + vec3f(f32(gx) - 1., f32(gy) - 1., f32(gz) - 1.);
                let cell_dist = (cx + 0.5) - p.position;
                let cidx = i32(cx.x) * i32(init_box_size.y) * i32(init_box_size.z)
                         + i32(cx.y) * i32(init_box_size.z)
                         + i32(cx.z);
                let wv = vec3f(
                    decodeFixedPoint(cells[cidx].vx),
                    decodeFixedPoint(cells[cidx].vy),
                    decodeFixedPoint(cells[cidx].vz)
                ) * weight;
                B += mat3x3f(wv * cell_dist.x, wv * cell_dist.y, wv * cell_dist.z);
                particles[id.x].v += wv;
            }
        }
    }

    particles[id.x].C = B * 4.0;
    particles[id.x].position += particles[id.x].v * dt;
    particles[id.x].position = clamp(
        particles[id.x].position,
        vec3f(1.),
        real_box_size - vec3f(2.)
    );

    let k = 3.0;
    let ws = 0.3;
    let xn    = particles[id.x].position + particles[id.x].v * dt * k;
    let wmin  = vec3f(3.);
    let wmax  = real_box_size - vec3f(4.);
    if (xn.x < wmin.x) { particles[id.x].v.x += ws * (wmin.x - xn.x); }
    if (xn.x > wmax.x) { particles[id.x].v.x += ws * (wmax.x - xn.x); }
    if (xn.y < wmin.y) { particles[id.x].v.y += ws * (wmin.y - xn.y); }
    if (xn.y > wmax.y) { particles[id.x].v.y += ws * (wmax.y - xn.y); }
    if (xn.z < wmin.z) { particles[id.x].v.z += ws * (wmin.z - xn.z); }
    if (xn.z > wmax.z) { particles[id.x].v.z += ws * (wmax.z - xn.z); }
}
`;

export const copyPositionWGSL = /* wgsl */`
struct Particle {
    position : vec3f,
    _pad0    : f32,
    v        : vec3f,
    _pad1    : f32,
    C        : mat3x3f,
}

struct PosVel {
    position : vec3f,
    _pad0    : f32,
    v        : vec3f,
    _pad1    : f32,
}

@group(0) @binding(0) var<storage, read>       particles : array<Particle>;
@group(0) @binding(1) var<storage, read_write> posvel    : array<PosVel>;

@compute @workgroup_size(64)
fn copyPosition(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x < arrayLength(&particles)) {
        posvel[id.x].position = particles[id.x].position;
        posvel[id.x].v        = particles[id.x].v;
    }
}
`;
