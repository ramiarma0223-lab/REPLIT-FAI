import { PDFDocument, rgb } from 'pdf-lib';

export interface AnnotationBox {
  x: number; // Absolute PDF points (same coordinate system as balloons)
  y: number;
  width: number;
  height: number;
  type: 'dimension' | 'gdt' | 'material' | 'process' | 'note' | 'functional_test';
  text: string;
  page: number; // 0-indexed page number
}

const ANNOTATION_COLORS = {
  dimension: rgb(0.2, 0.4, 1.0),      // Blue - dimensions with tolerances
  gdt: rgb(0.2, 0.8, 0.3),            // Green - GD&T symbols
  material: rgb(1.0, 0.8, 0.2),       // Yellow - material callouts
  process: rgb(1.0, 0.5, 0.2),        // Orange - process notes (ANODIZE, HEAT TREAT, etc.)
  note: rgb(0.8, 0.2, 0.8),           // Purple - general notes
  functional_test: rgb(1.0, 0.2, 0.2) // Red - functional tests and special inspections
};

export class PDFAnnotator {

  /**
   * Add color-coded annotation highlights to a PDF based on extracted characteristics
   * Creates visual "links" that show exactly what the AI detected
   */
  async annotatePDF(
    originalPdfBuffer: Buffer,
    annotations: AnnotationBox[]
  ): Promise<Buffer> {
    // Load the original PDF
    const pdfDoc = await PDFDocument.load(originalPdfBuffer);
    const pages = pdfDoc.getPages();

    // Group annotations by page
    const annotationsByPage = new Map<number, AnnotationBox[]>();
    for (const annotation of annotations) {
      const pageAnnotations = annotationsByPage.get(annotation.page) || [];
      pageAnnotations.push(annotation);
      annotationsByPage.set(annotation.page, pageAnnotations);
    }

    // Draw annotations on each page
    for (const [pageIndex, pageAnnotations] of Array.from(annotationsByPage.entries())) {
      if (pageIndex >= pages.length) continue;
      
      const page = pages[pageIndex];
      const { height: pageHeight } = page.getSize();

      for (const annotation of pageAnnotations) {
        const color = ANNOTATION_COLORS[annotation.type as keyof typeof ANNOTATION_COLORS];
        
        // Convert coordinates: PDF coordinates have origin at bottom-left
        // Our extraction coordinates have origin at top-left
        const pdfY = pageHeight - annotation.y - annotation.height;

        // Draw semi-transparent highlight rectangle
        page.drawRectangle({
          x: annotation.x - 2,
          y: pdfY - 2,
          width: annotation.width + 4,
          height: annotation.height + 4,
          borderColor: color,
          borderWidth: 2,
          opacity: 0.3,
          color: color
        });
      }
    }

    // Save the annotated PDF
    const annotatedPdfBytes = await pdfDoc.save();
    return Buffer.from(annotatedPdfBytes);
  }

  /**
   * Generate annotated PDF buffer ready for upload
   * Returns buffer that can be uploaded via ObjectStorageService
   * Note: Caller should use ObjectStorageService.uploadFile() for actual upload
   */
  async generateAnnotatedPDF(
    originalPdfBuffer: Buffer,
    annotations: AnnotationBox[]
  ): Promise<Buffer> {
    return this.annotatePDF(originalPdfBuffer, annotations);
  }

  /**
   * Create annotations from Gemini extraction results
   * Maps characteristic data to visual highlights
   */
  createAnnotationsFromCharacteristics(
    characteristics: Array<{
      characteristic: string;
      characteristicType: string;
      location?: { x: number; y: number; width: number; height: number };
      page?: number;
    }>
  ): AnnotationBox[] {
    const annotations: AnnotationBox[] = [];

    for (const char of characteristics) {
      if (!char.location || char.page === undefined) continue;

      // Determine annotation type from characteristic
      let type: AnnotationBox['type'] = 'dimension';
      
      if (char.characteristic.includes('⊥') || char.characteristic.includes('⌖') || 
          char.characteristic.includes('∥') || char.characteristic.includes('⌒')) {
        type = 'gdt';
      } else if (char.characteristicType === 'material') {
        type = 'material';
      } else if (char.characteristicType === 'process') {
        type = 'process';
      } else if (char.characteristicType === 'functional_test') {
        type = 'functional_test';
      } else if (char.characteristicType === 'note') {
        type = 'note';
      }

      annotations.push({
        x: char.location.x,
        y: char.location.y,
        width: char.location.width,
        height: char.location.height,
        type,
        text: char.characteristic,
        page: char.page
      });
    }

    return annotations;
  }
}

export const pdfAnnotator = new PDFAnnotator();
