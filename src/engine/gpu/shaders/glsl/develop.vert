#version 300 es
// Fullscreen triangle. Texture uploaded with UNPACK_FLIP_Y_WEBGL so v=0 is
// the image bottom, matching GL's bottom-left framebuffer origin.
out vec2 uv;
void main() {
  float x = float((gl_VertexID & 1) * 4 - 1);
  float y = float((gl_VertexID >> 1) * 4 - 1);
  gl_Position = vec4(x, y, 0.0, 1.0);
  uv = vec2(x, y) * 0.5 + 0.5;
}
