// ── Tipos del dominio Voice Quizzer ───────────────────────────────────────────

export interface Asignatura {
  email: string;
  nombre_asignatura: string;
  descripcion: string;
  icono: string;
}

export type TipoArchivo = 'PDF' | 'Markdown' | 'URL';

export interface Unidad {
  email: string;
  detalle_archivo: string;       // SK en DynamoDB: nombre_asignatura#nombre_unidad
  nombre_asignatura: string;
  nombre_unidad: string;
  descripcion: string;
  fecha_creacion: string;
  fecha_actualizacion: string;
  estado: 'pendiente' | 'listo'; // pendiente = sin índice FAISS, listo = RAG procesado
  ruta_s3: string;               // Ruta base en S3: voice-quizzer-maria/{email}/{asignatura}/{unidad}/
  tipo_archivo: TipoArchivo;
  nombre_archivo: string;        // Nombre del fichero (PDF/MD) o URL completa
  resumen?: string;              // Último resumen generado por Alexa (guardado en VQ_Unidad)
}

export interface HistorialItem {
  email: string;
  fecha_hora: string;            // SK en DynamoDB
  nombre_asignatura: string;
  nombre_unidad: string;
  tipo_cuestionario: string;
  num_preguntas: number;
  aciertos: number;
}

// ── Tipos de usuario ──────────────────────────────────────────────────────────

export interface CurrentUser {
  email: string;
  nombre: string;
  pin: string;
  foto?: string;  // Clave S3 de la foto de perfil: profile-pictures/{email}/photo
}

// ── Tipos de archivo local (uploader) ─────────────────────────────────────────

export interface CloudFile {
  name: string;
  size: string;
  type: string;
  lastModified: string;
}
