/**
 * The slice of three.js this app uses directly.
 *
 * three ships no type declarations of its own and @types/three is not a
 * dependency here — pulling it in for three classes would add a large,
 * version-coupled package to keep in step with whatever NGL depends on.
 * Declared narrowly instead: only the members surfacePick.ts actually calls,
 * so a typo in one of them is still a compile error.
 */
declare module 'three' {
  export class Vector2 {
    constructor(x?: number, y?: number)
    x: number
    y: number
  }
  export class Vector3 {
    constructor(x?: number, y?: number, z?: number)
    x: number
    y: number
    z: number
    copy(v: Vector3): this
    clone(): Vector3
    applyMatrix4(m: Matrix4): this
  }
  export class Matrix4 {
    copy(m: Matrix4): this
    invert(): this
  }
  export class Raycaster {
    setFromCamera(coords: Vector2, camera: unknown): void
    intersectObjects(objects: unknown[], recursive?: boolean): {
      point: Vector3
      object: { visible: boolean; geometry?: unknown; matrixWorld: Matrix4 }
    }[]
  }
}
