// Proxy Interface for Harmony Inclusion
// Type definitions for pdfmake 0.1
// Project: http://pdfmake.org
// Definitions by: Milen Stefanov <https://github.com/m1llen1um>
//                 Rajab Shakirov <https://github.com/radziksh>
//                 Enzo Volkmann <https://github.com/evolkmann>
// Definitions: https://github.com/DefinitelyTyped/DefinitelyTyped
// TypeScript Version: 2.4

interface TDocumentInformation {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
}

type Margins = number | [number, number] | [number, number, number, number];

type TDocumentHeaderFooterFunction = (
  currentPage: number,
  pageCount: number
) => any;

type Alignment = "left" | "right" | "justify" | "center" | string;

type TableRowFunction = (row: number) => number;

enum PageSize {
  A0_x_4 = "4A0",
  A0_x_2 = "2A0",
  AO = "A0",
  A1 = "A1",
  A2 = "A2",
  A3 = "A3",
  A4 = "A4",
  A5 = "A5",
  A6 = "A6",
  A7 = "A7",
  A8 = "A8",
  A9 = "A9",
  A1O = "A10",
  BO = "B0",
  B1 = "B1",
  B2 = "B2",
  B3 = "B3",
  B4 = "B4",
  B5 = "B5",
  B6 = "B6",
  B7 = "B7",
  B8 = "B8",
  B9 = "B9",
  B1O = "B10",
  CO = "C0",
  C1 = "C1",
  C2 = "C2",
  C3 = "C3",
  C4 = "C4",
  C5 = "C5",
  C6 = "C6",
  C7 = "C7",
  C8 = "C8",
  C9 = "C9",
  C1O = "C10",
  RA1 = "RA1",
  RA2 = "RA2",
  RA3 = "RA3",
  RA4 = "RA4",
  SRA1 = "SRA1",
  SRA2 = "SRA2",
  SRA3 = "SRA3",
  SRA4 = "SRA4",
  EXECUTIVE = "EXECUTIVE",
  FOLIO = "FOLIO",
  LEGAL = "LEGAL",
  LETTER = "LETTER",
  TABLOID = "TABLOID"
}

enum PageOrientation {
  PORTRAIT = "PORTRAIT",
  LANDSCAPE = "LANDSCAPE"
}

interface TableLayoutFunctions {
  hLineWidth?: (i: number, node: any) => number;
  vLineWidth?: (i: number, node: any) => number;
  hLineColor?: (i: number, node: any) => string;
  vLineColor?: (i: number, node: any) => string;
  fillColor?: (i: number, node: any) => string;
  paddingLeft?: (i: number, node: any) => number;
  paddingRight?: (i: number, node: any) => number;
  paddingTop?: (i: number, node: any) => number;
  paddingBottom?: (i: number, node: any) => number;
}

interface TableCell {
  text: string;
  rowSpan?: number;
  colSpan?: number;
  fillColor?: string;
  border?: [boolean, boolean, boolean, boolean];
}

interface Table {
  widths?: Array<string | number>;
  heights?: Array<string | number> | TableRowFunction;
  headerRows?: number;
  body: Content[][] | TableCell[][];
  layout?: string | TableLayoutFunctions;
}

interface Content {
  style?: "string";
  margin?: Margins;
  text?: string | string[] | Content[];
  columns?: Content[];
  stack?: Content[];
  image?: string;
  width?: string | number;
  height?: string | number;
  fit?: [number, number];
  pageBreak?: "before" | "after";
  alignment?: Alignment;
  table?: Table;
  ul?: Content[];
  ol?: Content[];
  [additionalProperty: string]: any;
}

interface Style {
  font?: any;
  fontSize?: number;
  fontFeatures?: any;
  bold?: boolean;
  italics?: boolean;
  alignment?: Alignment;
  color?: string;
  columnGap?: any;
  fillColor?: string;
  decoration?: any;
  decorationany?: any;
  decorationColor?: string;
  background?: any;
  lineHeight?: number;
  characterSpacing?: number;
  noWrap?: boolean;
  markerColor?: string;
  leadingIndent?: any;
  [additionalProperty: string]: any;
}

export interface TDocumentDefinitions {
  info?: TDocumentInformation;
  compress?: boolean;
  header?: TDocumentHeaderFooterFunction;
  footer?: TDocumentHeaderFooterFunction;
  content: string | Content;
  styles?: Style;
  pageSize?: PageSize;
  pageOrientation?: PageOrientation;
  pageMargins?: Margins;
  defaultStyle?: Style;
}

// Proxy Interface for Harmony Inclusion
// Type definitions for Pdfkit v0.7.2
// Project: http://pdfkit.org
// Definitions by: Eric Hillah <https://github.com/erichillah>
// Definitions: https://github.com/DefinitelyTyped/DefinitelyTyped

export declare namespace PDFKit {
    /**
   * Represent a single page in the PDF document
   */
    interface PDFPage {
        size: string;
        layout: string;
        margins: { top: number; left: number; bottom: number; right: number };
        width: number;
        height: number;
        document: PDFDocument;
        content: PDFKitReference;

    /**
     * The page dictionnary
     */
        dictionary: PDFKitReference;

        fonts: any;
        xobjects: any;
        ext_gstates: any;
        patterns: any;
        annotations: any;

        maxY(): number;
        write(chunk: any): void;
        end(): void;
    }

     /** PDFReference - represents a reference to another object in the PDF object heirarchy */
     class PDFKitReference {
        id: number;
        gen: number;
        deflate:any;
        compress: boolean;
        uncompressedLength: number;
        chunks: any[];
        data: { Font?: any; XObject?: any; ExtGState?: any; Pattern: any; Annots: any };
        document: PDFDocument;

        constructor(document: PDFDocument, id: number, data: {});
        initDeflate(): void;
        write(chunk: any): void;
        end(chunk: any): void;
        finalize(): void;
        toString(): string;
    }
}

export declare namespace PDFKit {
    interface DocumentInfo {
        Producer?: string;
        Creator?: string;
        CreationDate?: Date;
        Title?: string;
        Author?: string;
        Keywords?: string;
        ModDate?: Date;
    }

    interface PDFDocumentOptions {
        compress?: boolean;
        info?: DocumentInfo;
        autoFirstPage?: boolean;
        size?: number[]|string;
        margin?: number;
        margins?: { top: number; left: number; bottom: number; right: number };
        layout?: "portrait" | "landscape";

        bufferPages?: boolean;
    }

    interface PDFDocument extends NodeJS.ReadableStream,
        Mixins.PDFAnnotation<PDFDocument>, Mixins.PDFColor<PDFDocument>, Mixins.PDFImage<PDFDocument>,
        Mixins.PDFText<PDFDocument>, Mixins.PDFVector<PDFDocument>, Mixins.PDFFont<PDFDocument> {
        /**
        * PDF Version
        */
        version: number;
        /**
        * Wheter streams should be compressed
        */
        compress: boolean;
        /**
        * PDF document Metadata
        */
        info: DocumentInfo;
        /**
        * Options for the document
        */
        options: PDFDocumentOptions;
        /**
        * Represent the current page.
        */
        page: PDFPage;

        x: number;
        y: number;

        new (options?: PDFDocumentOptions): PDFDocument;

        addPage(options?: PDFDocumentOptions): PDFDocument;
        bufferedPageRange(): { start: number; count: number };
        switchToPage(n?: number): PDFPage;
        flushPages(): void;
        ref(data: {}): PDFKitReference;
        addContent(data: any): PDFDocument
        /**
        * Deprecated
        */
        write(fileName: string, fn: any): void;
        /**
        * Deprecated. Throws exception
        */
        output(fn: any): void;
        end(): void;
        toString(): string;
    }
}

export declare namespace PDFKit {
    interface PDFGradient {
        new(document: any): PDFGradient ;
        stop(pos: number, color?: string|PDFKit.PDFGradient, opacity?: number): PDFGradient;
        embed(): void;
        apply(): void;
    }

    interface PDFLinearGradient extends PDFGradient {
        new(document: any, x1: number, y1: number, x2: number, y2: number): PDFLinearGradient;
        shader(fn: () => any): any;
        opacityGradient(): PDFLinearGradient;
    }

    interface PDFRadialGradient extends PDFGradient {
        new(document: any, x1: number, y1: number, x2: number, y2: number): PDFRadialGradient;
        shader(fn: () => any): any;
        opacityGradient(): PDFRadialGradient;
    }
}

export declare namespace PDFKit.Mixins {

    interface AnnotationOption {
        Type?: string;
        Rect?: any;
        Border?: Array<number>;
        SubType?: string;
        Contents?: string;
        Name?: string;
        color?: string;
        QuadPoints?: Array<number>;

        A?: any;
        B?: any;
        C?: any;
        L?: any;
        DA?: string;
    }

    interface PDFAnnotation<TDocument> {
        annotate(x: number, y: number, w: number, h: number, option: AnnotationOption): TDocument;
        note(x: number, y: number, w: number, h: number, content: string, option?: AnnotationOption): TDocument;
        link(x: number, y: number, w: number, h: number, url: string, option?: AnnotationOption): TDocument;
        highlight(x: number, y: number, w: number, h: number, option?: AnnotationOption): TDocument;
        underline(x: number, y: number, w: number, h: number, option?: AnnotationOption): TDocument;
        strike(x: number, y: number, w: number, h: number, option?: AnnotationOption): TDocument;
        lineAnnotation(x1: number, y1: number, x2: number, y2: number, option?: AnnotationOption): TDocument;
        rectAnnotation(x: number, y: number, w: number, h: number, option?: AnnotationOption): TDocument;
        ellipseAnnotation(x: number, y: number, w: number, h: number, option?: AnnotationOption): TDocument;
        textAnnotation(x: number, y: number, w: number, h: number, text: string, option?: AnnotationOption): TDocument;
    }

    // The color forms accepted by PDFKit:
    //     example:   "red"                  [R, G, B]                  [C, M, Y, K]
    type ColorValue = string | PDFGradient | [number, number, number] | [number, number, number, number];

    // The winding / filling rule accepted by PDFKit:
    type RuleValue = "even-odd" | "evenodd" | "non-zero" | "nonzero";

    interface PDFColor<TDocument> {
        fillColor(color: ColorValue, opacity?: number): TDocument;
        strokeColor(color: ColorValue, opacity?: number): TDocument;
        opacity(opacity: number): TDocument;
        fillOpacity(opacity: number): TDocument;
        strokeOpacity(opacity: number): TDocument;
        linearGradient(x1: number, y1: number, x2: number, y2: number): PDFLinearGradient;
        radialGradient(x1: number, y1: number, r1: number, x2: number, y2: number, r2: number): PDFRadialGradient;
    }

    interface PDFFont<TDocument> {
        font(buffer: Buffer): TDocument;
        font(src: string, family?: string, size?: number): TDocument;
        fontSize(size: number): TDocument;
        currentLineHeight(includeGap?: boolean): number;
        registerFont(name: string, src?: string, family?: string): TDocument;
    }

    interface ImageOption {
        width?: number;
        height?: number;
        /** Scale percentage */
        scale?: number;
        /** Two elements array specifying dimensions(w,h)  */
        fit?: number[];
    }

    interface PDFImage<TDocument> {
        /**
         * Draw an image in PDFKit document.
         */
        image(src: any, x?: number, y?: number, options?: ImageOption): TDocument;
        image(src: any, options?: ImageOption): TDocument;
    }

    interface TextOptions {
        /**  Set to false to disable line wrapping all together */
        lineBreak?: boolean;
        /** The width that text should be wrapped to (by default, the page width minus the left and right margin) */
        width?: number;
        /**  The maximum height that text should be clipped to */
        height?: number;
        /** The character to display at the end of the text when it is too long. Set to true to use the default character. */
        ellipsis?: boolean|string;
        /**  the number of columns to flow the text into */
        columns?: number;
        /** the amount of space between each column (1/4 inch by default) */
        columnGap?: number;
        /** The amount in PDF points (72 per inch) to indent each paragraph of text */
        indent?: number;
        /** the amount of space between each paragraph of text */
        paragraphGap?: number;
        /** the amount of space between each line of text */
        lineGap?: number;
        /** the amount of space between each word in the text */
        wordSpacing?: number;
        /** the amount of space between each character in the text */
        characterSpacing?: number;
        /** whether to fill the text (true by default) */
        fill?: boolean;
        /**  whether to stroke the text */
        stroke?: boolean;
        /** A URL to link this text to (shortcut to create an annotation) */
        link?: string;
        /** whether to underline the text */
        underline?: boolean;
        /** whether to strike out the text */
        strike?: boolean;
        /**whether the text segment will be followed immediately by another segment. Useful for changing styling in the middle of a paragraph. */
        continued?: boolean;

        /** the alignment of the text (center, justify, left, right) */
        align?: string;
    }

    interface PDFText<TDocument> {
        lineGap(lineGap: number): TDocument;
        moveDown(line?: number): TDocument;
        moveUp(line?: number): TDocument;
        text(text: string, x?: number, y?: number, options?: TextOptions): TDocument;
        text(text: string, options?: TextOptions): TDocument;
        widthOfString(text: string, options?: TextOptions): number;
        heightOfString(text: string, options?: TextOptions): number;
        list(list: Array<string|any>, x?: number, y?: number, options?: TextOptions): TDocument;
        list(list: Array<string|any>, options?: TextOptions): TDocument;
    }

    interface PDFVector<TDocument> {

        save(): TDocument;
        restore(): TDocument;
        closePath(): TDocument;
        lineWidth(w: number): TDocument;
        lineCap(c: string): TDocument;
        lineJoin(j: string): TDocument;
        miterLimit(m: any): TDocument;
        dash(length: number, option: any): TDocument;
        undash(): TDocument;
        moveTo(x: number, y: number): TDocument;
        lineTo(x: number, y: number): TDocument;
        bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): TDocument;
        quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): TDocument;
        rect(x: number, y: number, w: number, h: number): TDocument;
        roundedRect(x: number, y: number, w: number, h: number, r?: number): TDocument;
        ellipse(x: number, y: number, r1: number, r2?: number): TDocument;
        circle(x: number, y: number, raduis: number): TDocument;
        polygon(...points: number[][]): TDocument;
        path(path: string): TDocument;
        fill(color?: ColorValue, rule?: RuleValue): TDocument;
        fill(rule: RuleValue): TDocument;
        stroke(color?: ColorValue): TDocument;
        fillAndStroke(fillColor?: ColorValue, strokeColor?: ColorValue, rule?: RuleValue): TDocument;
        fillAndStroke(fillColor: ColorValue, rule?: RuleValue): TDocument;
        fillAndStroke(rule: RuleValue): TDocument;
        clip(rule?: RuleValue): TDocument;
        transform(m11: number, m12: number, m21: number, m22: number, dx: number, dy: number): TDocument;
        translate(x: number, y: number): TDocument;
        rotate(angle: number, options?: { origin?: number[] }): TDocument;
        scale(xFactor: number, yFactor?: number, options?: { origin?: number[] }): TDocument;
    }
}