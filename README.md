# Reflective Shadow Maps in WebGL

Demo of approximate real-time indirect lighting with Reflective Shadows Maps using [regl](https://github.com/mikolalysenko/regl).

![](img.jpg)

[Demo here](https://erkaman.github.io/webgl-rsm/webgl-rsm.html)

# Implementation Details

This is an implementation of Indirect Lighting using [Reflective Shadow Maps](http://www.klayge.org/material/3_12/GI/rsm.pdf).
This technique results in some nice color bleeding effects, which can be seen in the red glow on Lucy(statue)
and the blue glow on the cute rabbit. This is light that has bounced from the colored walls.

We render the scene from the perspective of the light source, and for every
pixel we store the normal, world-space position and flux in a buffer, the RSM.
When shading a fragment, we will now gather the illumination from the adjacent
pixels in the RSM, and sum their contributions. We can by doing this 
approximate a lambertian diffuse indirect lighting component, and this results
in some nice color bleeding effects. 

The issue with the approach is that lots of samples must be taken for decent results.
Our implementation uses 64 samples, which is a lot, considering all these samples must 
be taken for every single fragment on the screen. In order to avoid doing this calculation
for invisible surfaces, we adopt a deferred shading approach. However, it is 
still quite expensive. 

In the original paper a screen-space interpolation approach is described, that
can greatly decrease the number of times we must perform the indirect lighting calculation.
In order to keep this demo simple, and because of laziness, we did not implement this, however.
Note that this is a possible future improvement to the implemention, though., 

# Build

First install all dependencies by doing

```bash
npm install
```

To then run the demo, do

```bash
npm run start
```
