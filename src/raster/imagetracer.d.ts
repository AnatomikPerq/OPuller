declare module 'imagetracerjs' {
  export interface ImageTracerOptions {
    ltres?: number;
    qtres?: number;
    pathomit?: number;
    rightangleenhance?: boolean;
    colorsampling?: number;
    numberofcolors?: number;
    mincolorratio?: number;
    colorquantcycles?: number;
    layering?: number;
    strokewidth?: number;
    linefilter?: boolean;
    scale?: number;
    roundcoords?: number;
    viewbox?: boolean;
    desc?: boolean;
    lcpr?: number;
    qcpr?: number;
    blurradius?: number;
    blurdelta?: number;
    pal?: Array<{ r: number; g: number; b: number; a: number }>;
  }
  interface ImageTracer {
    imagedataToSVG(imgd: ImageData, options?: ImageTracerOptions | string): string;
    imagedataToTracedata(imgd: ImageData, options?: ImageTracerOptions | string): unknown;
    getsvgstring(tracedata: unknown, options?: ImageTracerOptions | string): string;
    optionpresets: Record<string, ImageTracerOptions>;
    checkoptions(options?: ImageTracerOptions | string): ImageTracerOptions;
  }
  const tracer: ImageTracer;
  export default tracer;
}
