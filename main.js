const canvas = document.body.appendChild(document.createElement('canvas'))
var str = `<a href="https://github.com/Erkaman/webgl-rsm"><img style="position: absolute; top: 0; left: 0; border: 0;" src="https://camo.githubusercontent.com/82b228a3648bf44fc1163ef44c62fcc60081495e/68747470733a2f2f73332e616d617a6f6e6177732e636f6d2f6769746875622f726962626f6e732f666f726b6d655f6c6566745f7265645f6161303030302e706e67" alt="Fork me on GitHub" data-canonical-src="https://s3.amazonaws.com/github/ribbons/forkme_left_red_aa0000.png"></a>`

var container = document.createElement('div')
container.innerHTML = str
document.body.appendChild(container)

// load all modules here:
const fit = require('canvas-fit')
const regl = require('regl')({
  canvas: canvas,
  extensions: ['oes_texture_float', 'webgl_draw_buffers']
})
const mat4 = require('gl-mat4')
const quat = require('gl-quat')
const rand = require('seed-random')('myseed')
window.addEventListener('resize', fit(canvas), false)
const normals = require('angle-normals')

// generate samples according to formula (3) from the paper.
var NUM_SAMPLES = 64
var samples = []
for (var i = 0; i < NUM_SAMPLES; i++) {
  var xi1 = rand()
  var xi2 = rand()

  var x = xi1 * Math.sin(2 * Math.PI * xi2)
  var y = xi1 * Math.cos(2 * Math.PI * xi2)

  // we need xi1 for weighting, so include with sample.
  samples.push([x, y, xi1])
}

// next, we put samples into texture.
// determine power of two texture size:
var SAMPLES_TEX_SIZE = 1
while (SAMPLES_TEX_SIZE < NUM_SAMPLES) {
  SAMPLES_TEX_SIZE *= 2
}
var dat = []
for (i = 0; i < SAMPLES_TEX_SIZE; i++) {
  var p
  if (i < NUM_SAMPLES) {
    p = samples[i]
  } else {
    p = [0.0, 0.0, 0.0]
  }

  dat.push(p[0])
  dat.push(p[1])
  dat.push(p[2])
  dat.push(0.0) // alpha channed is unused.
}
var samplesTexture = regl.texture({
  width: SAMPLES_TEX_SIZE,
  height: 1,
  wrap: 'repeat',
  mag: 'nearest',
  min: 'nearest',
  type: 'float',
  data: dat})

// boilerplate vertex shader used for fullscreen passes.
var fullscreenVs = `
precision mediump float;
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = 0.5 * (position + 1.0);
  gl_Position = vec4(position, 0, 1);
}`

// resolution of RSM.
var RSM_RES = 1024

const rsmFbo = regl.framebuffer({
  color: [
    regl.texture({type: 'float'}), // depth
    regl.texture({type: 'float'}), // normal
    regl.texture({type: 'float'}), // flux
    regl.texture({type: 'float'}) // world-space pos
  ],
  depth: true
})

const gbufferFbo = regl.framebuffer({
  color: [
    regl.texture({type: 'float'}), // normal
    regl.texture({type: 'float'}), // albedo
    regl.texture({type: 'float'}) // world-space pos

  ],
  depth: true
})

// camera settings.
const camera = require('regl-camera')(regl, {
  center: [0, 0, 0],

  distance: 140,
  theta: 0.17,
  phi: 0.7,

  near: 0.01,
  far: 1000
})

const globalScope = regl({
  context: {
    lightDir: [0.23, 0.79, 0.55]
  },
  uniforms: {
    ambientLightAmount: 0.3,
    diffuseLightAmount: 0.7,
    indirectLightAmount: 3.0,

    // the samles are on a disk, and this is the radius
    // of that disk.

    // the 300.0 value may have to be tweaked, depending on the scene.
    sampleRadius: 300.0,

    lightDir: regl.context('lightDir'),
    lightView: (context) => {
      return mat4.lookAt([], context.lightDir, [0.0, 0.0, 0.0], [0.0, 1.0, 0.0])
    },
    lightProjection: mat4.ortho([], -60, 90, -80, 90, -130, 30)
  }
})

// plane geometry arrays.
const planeElements = []
var planePosition = []
var planeNormal = []

// up facing
planePosition.push([-1.0, 0, -1.0])
planePosition.push([+1.0, 0, -1.0])
planePosition.push([-1.0, 0, +1.0])
planePosition.push([+1.0, 0, +1.0])

// down facing.
planePosition.push([-1.0, 0, -1.0])
planePosition.push([+1.0, 0, -1.0])
planePosition.push([-1.0, 0, +1.0])
planePosition.push([+1.0, 0, +1.0])

var n0 = [0.0, +1.0, 0.0] // up normal
var n1 = [0.0, -1.0, 0.0] // down normal.

planeNormal.push(n0)
planeNormal.push(n0)
planeNormal.push(n0)
planeNormal.push(n0)
planeNormal.push(n1)
planeNormal.push(n1)
planeNormal.push(n1)
planeNormal.push(n1)

planeElements.push([3, 1, 0])
planeElements.push([0, 2, 3])
planeElements.push([4, 5, 7])
planeElements.push([7, 6, 4])

// pass that computes the direct lighting.
const directLightingPass = regl({
  frag: `
  precision mediump float;
  varying vec2 uv;

  uniform vec3 color;
  uniform vec3 lightDir;

  uniform sampler2D shadowMap;

  uniform sampler2D normalTex;
  uniform sampler2D albedoTex;
  uniform sampler2D worldPosTex;

  uniform float ambientLightAmount;
  uniform float diffuseLightAmount;

#define texelSize 1.0 / float(${RSM_RES})

  uniform float minBias;
  uniform float maxBias;

  uniform mat4 lightProjection, lightView;

  float shadowSample(vec2 co, float z, float bias) {
    float a = texture2D(shadowMap, co).z;
    float b = z;
    return step(b-bias, a);
  }

  void main () {

    vec3 n = texture2D(normalTex, uv).xyz;
    vec3 albedo = texture2D(albedoTex, uv).xyz;
    vec3 p = texture2D(worldPosTex, uv).xyz;

    vec3 ambient = ambientLightAmount * albedo;
    float cosTheta = dot(n, lightDir);

    vec4 shadowCoord = (lightProjection * lightView * vec4(p,1.0) );
    shadowCoord.xyz /= shadowCoord.w;

    float v = 1.0; // shadow value
    vec2 co = shadowCoord.xy * 0.5 + 0.5;
    // counteract shadow acne.
    float bias = max(maxBias * (1.0 - cosTheta), minBias);
    float v0 = shadowSample(co + texelSize * vec2(0.0, 0.0), shadowCoord.z, bias);
    float v1 = shadowSample(co + texelSize * vec2(1.0, 0.0), shadowCoord.z, bias);
    float v2 = shadowSample(co + texelSize * vec2(0.0, 1.0), shadowCoord.z, bias);
    float v3 = shadowSample(co + texelSize * vec2(1.0, 1.0), shadowCoord.z, bias);
    v = (v0 + v1 + v2 + v3) * (1.0 / 4.0);

    vec3 diffuse = diffuseLightAmount * albedo * clamp(cosTheta , 0.0, 1.0 );

    gl_FragColor = vec4(ambient  + diffuse *v, 1.0);
  }`,
  vert: fullscreenVs,
  attributes: {
    // We implement the full-screen pass by using a full-screen triangle
    position: [ -4, -4, 4, -4, 0, 4 ]
  },
  uniforms: {
    shadowMap: rsmFbo.color[0],

    normalTex: gbufferFbo.color[0],
    albedoTex: gbufferFbo.color[1],
    worldPosTex: gbufferFbo.color[2],

    minBias: () => 0.005,
    maxBias: () => 0.03

  },
  depth: { enable: false },
  count: 3
})

const indirectLightingPass = regl({
  frag: `
  precision mediump float;
  varying vec2 uv;

  uniform vec3 color;
  uniform vec3 lightDir;

  uniform sampler2D shadowMap;

  uniform sampler2D gNormalTex;
  uniform sampler2D gWorldPosTex;

  uniform sampler2D rNormalTex;
  uniform sampler2D rWorldPosTex;
  uniform sampler2D rFluxTex;
  uniform sampler2D samplesTex;

  uniform float indirectLightAmount;
  uniform float sampleRadius;

#define texelSize 1.0 / float(${RSM_RES})

  uniform mat4 lightProjection, lightView;

  vec3 indirect() {
    vec3 P = texture2D(gWorldPosTex, uv).xyz;
    vec3 N = texture2D(gNormalTex, uv).xyz;

    vec4 texPos = (lightProjection * lightView * vec4(P, 1.0));
    texPos.xyz /= texPos.w;

    vec3 indirect = vec3(0.0, 0.0, 0.0);
    texPos.xyz = texPos.xyz * 0.5 + 0.5;

    for(int i = 0; i < int(${NUM_SAMPLES}); i++) {
      vec3 s = texture2D(samplesTex, vec2( float(i) / float(${SAMPLES_TEX_SIZE}),0.0)  ).xyz;
      vec2 offset = s.xy;
      float weight = s.z;

      vec2 coords = texPos.xy + offset * sampleRadius * texelSize;

      vec3 vplPos = texture2D(rWorldPosTex, coords).xyz;
      vec3 vplNormal = texture2D(rNormalTex, coords).xyz;
      vec3 vplFlux = texture2D(rFluxTex, coords).xyz;

      // formula (1) from the paper. except that we normalize inside the dot product,
      // instead of outside, like they seem to do.
      vec3 result = vplFlux * (max(0.0, dot( vplNormal, normalize(P - vplPos) ))
                               * max(0.0, dot(N, normalize(vplPos - P) )));

      // like in the paper, we weight by xi1 squared.
      result *= weight * weight;
      result *= (1.0 / float(${NUM_SAMPLES}));
      indirect +=result;
    }
    return clamp(indirect *indirectLightAmount, 0.0, 1.0);
  }

  void main () {
    gl_FragColor = vec4( indirect(), 1.0);
  }`,
  vert: fullscreenVs,
  attributes: {
    // We implement the full-screen pass by using a full-screen triangle
    position: [ -4, -4, 4, -4, 0, 4 ]
  },
  uniforms: {
    gNormalTex: gbufferFbo.color[0],
    gWorldPosTex: gbufferFbo.color[2],

    rNormalTex: rsmFbo.color[1],
    rFluxTex: rsmFbo.color[2],
    rWorldPosTex: rsmFbo.color[3],

    samplesTex: samplesTexture
  },
  depth: { enable: false },
  count: 3,

  blend: {
    enable: true,
    func: {
      src: 1,
      dst: 1
    }
  }
})

// draw to rsm buffer.
const drawRsm = regl({
  frag: `
#extension GL_EXT_draw_buffers : require
  precision mediump float;
  varying vec3 vPosition;
  varying vec3 vNormal;
  varying vec3 vWorldSpacePosition;

  uniform vec3 color;

  void main () {
    gl_FragData[0] = vec4(vec3(vPosition.z), 1.0);
    gl_FragData[1] = vec4(vec3(vNormal.xyz), 1.0);
    gl_FragData[2] = vec4(vec3(color.xyz), 1.0);
    gl_FragData[3] = vec4(vec3(vWorldSpacePosition.xyz), 1.0);
  }`,
  vert: `
  precision mediump float;
  attribute vec3 position;
  attribute vec3 normal;
  varying vec3 vPosition;
  varying vec3 vWorldSpacePosition;

  varying vec3 vNormal;
  uniform mat4 lightProjection, lightView, model, normalMatrix;
  void main() {
    vec4 worldSpacePos = model * vec4(position , 1);
    vec4 p = lightProjection * lightView * worldSpacePos;
    vNormal = normalize((normalMatrix * vec4(normal, 0.0)).xyz);

    vPosition = p.xyz / p.w;
    vWorldSpacePosition = worldSpacePos.xyz;
    gl_Position = p;
  }`,

  framebuffer: rsmFbo
})

// draw to gbuffer.
const drawGbuffer = regl({
  frag: `
#extension GL_EXT_draw_buffers : require
  precision mediump float;
  varying vec3 vPosition;
  varying vec3 vNormal;
  varying vec3 vWorldSpacePosition;

  uniform vec3 color;

  void main () {
    gl_FragData[0] = vec4(vec3(vNormal.xyz), 1.0);
    gl_FragData[1] = vec4(vec3(color.xyz), 1.0);
    gl_FragData[2] = vec4(vec3(vWorldSpacePosition.xyz), 1.0);
  }`,
  vert: `
  precision mediump float;
  attribute vec3 position;
  attribute vec3 normal;
  varying vec3 vPosition;
  varying vec3 vWorldSpacePosition;

  varying vec3 vNormal;
  uniform mat4  model, normalMatrix, projection, view;
  void main() {
    vec4 worldSpacePos = model * vec4(position , 1);
    vec4 p = projection * view * worldSpacePos;
    vNormal = normalize((normalMatrix * vec4(normal, 0.0)).xyz);

    vPosition = p.xyz / p.w;
    vWorldSpacePosition = worldSpacePos.xyz;
    gl_Position = p;
  }`,

  framebuffer: gbufferFbo
})

function Mesh (elements, position, normal) {
  this.elements = elements
  this.position = position
  this.normal = normal
}

// get single matrix from quaternion, translation and scale.
function fromRotationTranslationScale2 (out, q, v, s) {
  mat4.identity(out)

  var quatMat = mat4.create()
  mat4.fromQuat(quatMat, q)

  mat4.translate(out, out, v)
  mat4.multiply(out, out, quatMat)
  mat4.scale(out, out, s)

  return out
}

Mesh.prototype.draw = regl({

  context: {
    model: (_, props, batchId) => {
      var m = mat4.identity([])

      var rot = quat.create()
      quat.rotateX(rot, rot, props.rotation[0])
      quat.rotateY(rot, rot, props.rotation[1])
      quat.rotateZ(rot, rot, props.rotation[2])

      fromRotationTranslationScale2(m, rot, props.translate, [props.scale, props.scale, props.scale])

      return m
    }
  },

  uniforms: {
    model: regl.context('model'),
    normalMatrix: (context) => {
      return mat4.transpose([], mat4.invert([], context.model))
    },
    color: regl.prop('color')
  },
  attributes: {
    position: regl.this('position'),
    normal: regl.this('normal')
  },
  elements: regl.this('elements'),
  cull: {
    enable: true
  }
})

// we load the meshes using resl.
require('resl')({
  manifest: {
    bunnyJson: {
      type: 'text',
      src: 'bunny.json',
      parser: JSON.parse
    },
    lucyJson: {
      type: 'text',
      src: 'lucy.json',
      parser: JSON.parse
    }
  },

  onDone: (assets) => {
    var bunnyJson = assets.bunnyJson
    var lucyJson = assets.lucyJson

    // setup the meshes.
    var bunnyMesh = new Mesh(bunnyJson.cells, bunnyJson.positions, normals(bunnyJson.cells, bunnyJson.positions))
    var lucyMesh = new Mesh(lucyJson.cells, lucyJson.positions, normals(lucyJson.cells, lucyJson.positions))
    var planeMesh = new Mesh(planeElements, planePosition, planeNormal)

    regl.frame(({tick, viewportWidth, viewportHeight}) => {
      rsmFbo.resize(RSM_RES, RSM_RES)
      gbufferFbo.resize(viewportWidth, viewportHeight)

      var drawObjects = () => {
        var c = [0.6, 0.6, 0.6]

        bunnyMesh.draw({scale: 2.0, translate: [0, 8.0, 30], color: c, rotation: [0.0, 0.8, 0.0]})
        lucyMesh.draw({scale: 1.0, translate: [30, 0.0, 0], color: c, rotation: [0.0, 0.0, 0.0]})

        planeMesh.draw({scale: 50.0, translate: [25.0, 0.0, 25.0], color: [1.0, 1.0, 1.0], rotation: [0.0, 0.0, 0.0]})

        var ax = 25
        var az = 25

        planeMesh.draw({scale: 50.0, translate: [0.0 + ax, 50.0, -50.0 + az], color: [1.0, 0.0, 0.0], rotation: [3.14 * 0.5, 0.0, 0]})
        planeMesh.draw({scale: 50.0, translate: [-50.0 + ax, 50.0, 0.0 + az], color: [0.0, 0.0, 1.0], rotation: [0.0, 0.0, 3.14 * 0.5]})
      }

      camera(() => {
        regl.clear({
          color: [0, 0, 0, 255],
          depth: 1
        })

        globalScope(() => {
          drawRsm({}, () => {
            regl.clear({color: [0, 0, 0, 255], depth: 1})
            drawObjects()
          })

          drawGbuffer({}, () => {
            regl.clear({color: [0, 0, 0, 255], depth: 1})

            drawObjects()
          })
          directLightingPass()
          indirectLightingPass()
        })
      })
    })
  }
})
