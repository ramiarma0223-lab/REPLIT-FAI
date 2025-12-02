import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const projects = pgTable("projects", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  partNumber: text("part_number").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const drawings = pgTable("drawings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: varchar("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text("name").notNull(),
  pdfUrl: text("pdf_url").notNull(),
  annotatedPdfUrl: text("annotated_pdf_url"), // Color-coded highlights showing AI extraction results
  thumbnailUrl: text("thumbnail_url"),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  
  // Page dimensions for drawing zone calculation
  pageWidth: real("page_width"), // PDF page width in points (1/72 inch)
  pageHeight: real("page_height"), // PDF page height in points
});

export const characteristics = pgTable("characteristics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  drawingId: varchar("drawing_id").notNull().references(() => drawings.id, { onDelete: 'cascade' }),
  balloonNumber: integer("balloon_number").notNull(),
  description: text("description").notNull(),
  
  // Numeric fields optional - only required for dimensions, notes/materials/processes use N/A or empty values
  specification: text("specification"), // Nullable - notes/materials may not have numeric spec
  tolerancePlus: real("tolerance_plus"), // Nullable - notes don't have tolerances
  toleranceMinus: real("tolerance_minus"), // Nullable - notes don't have tolerances
  unit: text("unit"), // Nullable - "N/A" for notes/materials/processes
  
  inspectionMethod: text("inspection_method").notNull(),
  sampleSize: integer("sample_size").notNull(),
  gdtType: text("gdt_type"),
  gdtTolerance: real("gdt_tolerance"),
  region: varchar("region").notNull().default("part"), // Classification: part, template, uncertain
  
  // AS9102 Compliance Fields
  characteristicDesignator: varchar("characteristic_designator").default("N/A"), // Critical, Key, Major, Minor, N/A (Form 3 Box 7)
  drawingZone: varchar("drawing_zone"), // e.g., "A-2", "D-3", "Sheet 1" (Form 3 Box 6)
  quantity: varchar("quantity"), // e.g., "4X", "2X" for multiple instances
  requirementType: varchar("requirement_type").notNull().default("dimension"), // dimension, note, material, process, functional
  surfaceFinish: text("surface_finish"), // e.g., "Ra 63", "125 RMS" for specific callouts
  passFailExpected: boolean("pass_fail_expected"), // true: expects PASS/FAIL (notes/materials), false/null: expects numeric (dimensions)
});

export const balloons = pgTable("balloons", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  characteristicId: varchar("characteristic_id").notNull().references(() => characteristics.id, { onDelete: 'cascade' }),
  drawingId: varchar("drawing_id").notNull().references(() => drawings.id, { onDelete: 'cascade' }),
  balloonNumber: integer("balloon_number").notNull(),
  xPosition: real("x_position").notNull(),
  yPosition: real("y_position").notNull(),
  leaderX: real("leader_x").notNull(),
  leaderY: real("leader_y").notNull(),
});

export const inspections = pgTable("inspections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  characteristicId: varchar("characteristic_id").notNull().references(() => characteristics.id, { onDelete: 'cascade' }),
  
  // Support both numeric results (dimensions) and pass/fail results (notes, processes)
  actualValue: real("actual_value"), // For numeric measurements (dimensions, GD&T)
  passFailResult: varchar("pass_fail_result"), // For non-numeric: "PASS", "FAIL", "YES", "NO", "ACCEPT"
  
  passed: boolean("passed").notNull(), // Computed: true if within tolerance OR passFailResult is positive
  notes: text("notes"),
  inspectedAt: timestamp("inspected_at").defaultNow().notNull(),
  inspectorName: text("inspector_name"),
  
  // LM FAI Compliance: Equipment and inspector traceability
  equipmentId: varchar("equipment_id").references(() => equipment.id, { onDelete: 'set null' }),
  inspectorId: varchar("inspector_id").references(() => inspectors.id, { onDelete: 'set null' }),
  
  // LM FAI Compliance: Non-conformance tracking
  ncrNumber: text("ncr_number"), // Non-Conformance Report number if characteristic failed
  disposition: varchar("disposition"), // accept_as_is, rework, scrap, use_as_is, MRB
  correctiveAction: text("corrective_action"), // Description of corrective action taken
  ncrAttachmentUrl: text("ncr_attachment_url"), // URL to NCR documentation in object storage
});

export const reports = pgTable("reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: varchar("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
  drawingId: varchar("drawing_id").notNull().references(() => drawings.id, { onDelete: 'cascade' }),
  reportType: text("report_type").notNull(),
  pdfUrl: text("pdf_url"),
  generatedAt: timestamp("generated_at").defaultNow().notNull(),
  generatedBy: text("generated_by"),
});

export const partMetadata = pgTable("part_metadata", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  drawingId: varchar("drawing_id").notNull().references(() => drawings.id, { onDelete: 'cascade' }),
  material: text("material"),
  surfaceFinish: text("surface_finish"),
  deburringRequirements: text("deburring_requirements"),
  breakCorners: text("break_corners"),
  partMark: text("part_mark"),
  installationNotes: text("installation_notes"),
  generalNotes: text("general_notes").array(), // Array to preserve multiple notes structure
  extractedAt: timestamp("extracted_at").defaultNow().notNull(),
});

// New table to persist filtered (template/uncertain) dimensions for audit trail
export const filteredDimensions = pgTable("filtered_dimensions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  drawingId: varchar("drawing_id").notNull().references(() => drawings.id, { onDelete: 'cascade' }),
  description: text("description").notNull(),
  nominalValue: real("nominal_value").notNull(),
  tolerancePlus: real("tolerance_plus"), // Nullable - Gemini may not extract for all dimensions
  toleranceMinus: real("tolerance_minus"), // Nullable - Gemini may not extract for all dimensions
  unit: text("unit").notNull(),
  gdtType: text("gdt_type"),
  gdtTolerance: real("gdt_tolerance"),
  region: varchar("region").notNull(), // "template" or "uncertain"
  filterReason: text("filter_reason"), // Why it was filtered
  extractedAt: timestamp("extracted_at").defaultNow().notNull(),
});

// PDF annotation metadata: stores bounding boxes for color-coded highlights
export const drawingAnnotations = pgTable("drawing_annotations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  drawingId: varchar("drawing_id").notNull().references(() => drawings.id, { onDelete: 'cascade' }),
  characteristicId: varchar("characteristic_id").references(() => characteristics.id, { onDelete: 'cascade' }), // Optional link to characteristic
  extractionKey: varchar("extraction_key"), // Stable key for linking during extraction (index or UUID)
  page: integer("page").notNull(), // PDF page number (0-indexed)
  annotationType: varchar("annotation_type").notNull(), // dimension, gdt, material, process, note, functional_test
  
  // Bounding box coordinates (absolute PDF points, top-left origin, same as balloon coords)
  x: real("x").notNull(),
  y: real("y").notNull(),
  width: real("width").notNull(),
  height: real("height").notNull(),
  
  textSnippet: text("text_snippet").notNull(), // Extracted text for this annotation
  aiConfidence: real("ai_confidence"), // Gemini confidence score (0-1)
  status: varchar("status").notNull().default("ai_generated"), // ai_generated, user_validated, user_corrected
  
  createdBy: varchar("created_by").default("system"), // system or user ID
  updatedBy: varchar("updated_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Annotation feedback: captures user corrections for continuous learning
export const annotationFeedback = pgTable("annotation_feedback", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  annotationId: varchar("annotation_id").notNull().references(() => drawingAnnotations.id, { onDelete: 'cascade' }),
  feedbackType: varchar("feedback_type").notNull(), // accepted, corrected, deleted, false_positive, false_negative
  
  // Original vs corrected values for learning
  originalType: varchar("original_type"),
  correctedType: varchar("corrected_type"),
  originalText: text("original_text"),
  correctedText: text("corrected_text"),
  
  userComments: text("user_comments"), // Why user made this correction
  submittedBy: varchar("submitted_by"), // User who provided feedback
  submittedAt: timestamp("submitted_at").defaultNow().notNull(),
});

// LM FAI Compliance: Equipment registry for calibrated measurement tools
export const equipment = pgTable("equipment", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: varchar("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
  equipmentId: text("equipment_id").notNull(), // Customer-assigned equipment ID (e.g., "CMM-001", "CAL-123")
  description: text("description").notNull(), // Equipment description (e.g., "Mitutoyo CMM", "6-inch Digital Caliper")
  manufacturer: text("manufacturer"),
  model: text("model"),
  accuracyRatio: real("accuracy_ratio"), // Ratio of equipment accuracy to tolerance (LM requires 10:1 minimum)
  calibrationDueDate: timestamp("calibration_due_date"), // When calibration expires
  calibrationCertNumber: text("calibration_cert_number"), // Calibration certificate reference
  status: varchar("status").notNull().default("active"), // active, out_of_cal, retired
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// LM FAI Compliance: Inspector qualifications and certifications
export const inspectors = pgTable("inspectors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: varchar("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text("name").notNull(),
  certification: text("certification"), // Certification type (e.g., "AS9102 Level II", "CMM Certified")
  certificationNumber: text("certification_number"),
  qualificationDate: timestamp("qualification_date"),
  expirationDate: timestamp("expiration_date"),
  status: varchar("status").notNull().default("active"), // active, expired, suspended
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertProjectSchema = createInsertSchema(projects).omit({ id: true, createdAt: true });
export const insertDrawingSchema = createInsertSchema(drawings).omit({ id: true, uploadedAt: true });
export const insertCharacteristicSchema = createInsertSchema(characteristics).omit({ id: true });
export const insertDrawingAnnotationSchema = createInsertSchema(drawingAnnotations).omit({ id: true, createdAt: true, updatedAt: true });
export const insertAnnotationFeedbackSchema = createInsertSchema(annotationFeedback).omit({ id: true, submittedAt: true });
export const manualCharacteristicInputSchema = insertCharacteristicSchema.omit({ balloonNumber: true }).extend({
  // Make AS9102 fields optional for manual entry with sensible defaults
  characteristicDesignator: z.enum(["Critical", "Key", "Major", "Minor", "N/A"]).optional(),
  drawingZone: z.string().optional(),
  quantity: z.string().optional(),
  requirementType: z.enum(["dimension", "note", "material", "process", "functional"]).optional(),
  surfaceFinish: z.string().optional(),
});
export const insertBalloonSchema = createInsertSchema(balloons).omit({ 
  id: true,
  leaderX: true,  // Leader coords computed server-side only
  leaderY: true,
});
// Helper to normalize pass/fail strings to boolean
export function normalizePassFail(value: string): boolean {
  const normalized = value.toUpperCase().trim();
  const passValues = ["PASS", "YES", "ACCEPT", "TRUE", "OK", "ACCEPTABLE"];
  const failValues = ["FAIL", "NO", "REJECT", "FALSE", "NOT OK", "UNACCEPTABLE"];
  
  if (passValues.includes(normalized)) return true;
  if (failValues.includes(normalized)) return false;
  
  throw new Error(`Invalid pass/fail value: ${value}. Expected one of: ${[...passValues, ...failValues].join(", ")}`);
}

// Inspection schema with XOR validation: exactly one of actualValue or passFailResult
export const insertInspectionSchema = createInsertSchema(inspections)
  .omit({ id: true, inspectedAt: true })
  .superRefine((data, ctx) => {
    const hasActualValue = data.actualValue !== null && data.actualValue !== undefined;
    const hasPassFail = data.passFailResult !== null && data.passFailResult !== undefined && data.passFailResult.trim() !== "";
    
    // XOR: exactly one must be provided
    if (!hasActualValue && !hasPassFail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Must provide either actualValue (for numeric measurements) or passFailResult (for pass/fail verification)",
        path: ["actualValue"],
      });
    }
    
    if (hasActualValue && hasPassFail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cannot provide both actualValue and passFailResult. Choose one based on characteristic type.",
        path: ["actualValue"],
      });
    }
    
    // Validate passFailResult format if provided
    if (hasPassFail) {
      try {
        normalizePassFail(data.passFailResult!);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : "Invalid pass/fail value",
          path: ["passFailResult"],
        });
      }
    }
  });
export const insertReportSchema = createInsertSchema(reports).omit({ id: true, generatedAt: true });
export const insertPartMetadataSchema = createInsertSchema(partMetadata).omit({ id: true, extractedAt: true });
export const insertFilteredDimensionSchema = createInsertSchema(filteredDimensions).omit({ id: true, extractedAt: true });
export const insertEquipmentSchema = createInsertSchema(equipment).omit({ id: true, createdAt: true });
export const insertInspectorSchema = createInsertSchema(inspectors).omit({ id: true, createdAt: true });

export type Project = typeof projects.$inferSelect;
export type Drawing = typeof drawings.$inferSelect;
export type Characteristic = typeof characteristics.$inferSelect;
export type Balloon = typeof balloons.$inferSelect;
export type Inspection = typeof inspections.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type PartMetadata = typeof partMetadata.$inferSelect;
export type FilteredDimension = typeof filteredDimensions.$inferSelect;
export type DrawingAnnotation = typeof drawingAnnotations.$inferSelect;
export type AnnotationFeedback = typeof annotationFeedback.$inferSelect;
export type Equipment = typeof equipment.$inferSelect;
export type Inspector = typeof inspectors.$inferSelect;

export type InsertProject = z.infer<typeof insertProjectSchema>;
export type InsertDrawing = z.infer<typeof insertDrawingSchema>;
export type InsertCharacteristic = z.infer<typeof insertCharacteristicSchema>;
export type InsertBalloon = z.infer<typeof insertBalloonSchema>;
export type InsertInspection = z.infer<typeof insertInspectionSchema>;
export type InsertReport = z.infer<typeof insertReportSchema>;
export type InsertPartMetadata = z.infer<typeof insertPartMetadataSchema>;
export type InsertFilteredDimension = z.infer<typeof insertFilteredDimensionSchema>;
export type InsertDrawingAnnotation = z.infer<typeof insertDrawingAnnotationSchema>;
export type InsertAnnotationFeedback = z.infer<typeof insertAnnotationFeedbackSchema>;
export type InsertEquipment = z.infer<typeof insertEquipmentSchema>;
export type InsertInspector = z.infer<typeof insertInspectorSchema>;
