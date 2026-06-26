// Autor:   María León Pérez
// Resumen: Pantalla de creación y edición de unidades didácticas. Gestiona la subida de
//          archivos PDF/Markdown directamente a S3 (upload firmado con AWS Signature V4)
//          y el guardado de URLs externas. Tras guardar en DynamoDB llama al backend Flask
//          (POST /procesar) para disparar la indexación RAG. Si Flask no está disponible,
//          la unidad queda en estado 'pendiente' y puede reintentarse más tarde.
//          El nombre de la unidad es inmutable una vez creada (es parte de la clave S3).
import React, { useState } from 'react';
import {
  ChevronLeft, Upload, FileText, Trash2, Eye, RefreshCw, Save, Link, ExternalLink,
} from 'lucide-react';
import { motion } from 'motion/react';
import { Unidad, TipoArchivo } from '../types';
import { dynamo, s3Upload, s3Delete, s3PresignedUrl, BUCKET } from '../lib/aws';

interface GestionUnidadProps {
  email: string;
  nombreAsignatura: string;
  unidad?: Unidad;
  onBack: () => void;
}

// ── DynamoDB helpers ──────────────────────────────────────────────────────────

/**
 * Persiste la unidad en VQ_Unidad con PutItem. En modo creación usa ConditionExpression
 * para rechazar nombres duplicados dentro de la misma asignatura. En modo edición omite
 * la condición porque el registro ya existe y queremos sobreescribirlo.
 * La detección de modo (creación vs edición) se basa en si fecha_creacion === fecha_actualizacion.
 */
async function guardarUnidad(unidad: Unidad): Promise<{ error?: string }> {
  const id  = `${unidad.email}#${unidad.nombre_asignatura}#${unidad.nombre_unidad}`;
  const res = await dynamo('DynamoDB_20120810.PutItem', {
    TableName: 'VQ_Unidad',
    Item: {
      id_unidad:           { S: id },
      detalle_archivo:     { S: unidad.detalle_archivo },
      email:               { S: unidad.email },
      nombre_asignatura:   { S: unidad.nombre_asignatura },
      nombre_unidad:       { S: unidad.nombre_unidad },
      descripcion:         { S: unidad.descripcion },
      fecha_creacion:      { S: unidad.fecha_creacion },
      fecha_actualizacion: { S: unidad.fecha_actualizacion },
      estado:              { S: unidad.estado },
      ruta_s3:             { S: unidad.ruta_s3 },
      tipo_archivo:        { S: unidad.tipo_archivo },
      nombre_archivo:      { S: unidad.nombre_archivo },
    },
    // Solo aplica ConditionExpression si es creación nueva (no edición)
    ...(!unidad.fecha_creacion || unidad.fecha_creacion === unidad.fecha_actualizacion
      ? { ConditionExpression: 'attribute_not_exists(id_unidad)' }
      : {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body.__type?.includes('ConditionalCheckFailed')) {
      return { error: 'Ya existe una unidad con ese nombre en esta asignatura.' };
    }
    console.error('DynamoDB guardarUnidad error:', body);
    return { error: 'Error guardando la unidad. Inténtalo de nuevo.' };
  }
  return {};
}

// ── Componente ────────────────────────────────────────────────────────────────

const TIPOS: { value: TipoArchivo; label: string }[] = [
  { value: 'PDF',      label: 'Archivo PDF' },
  { value: 'Markdown', label: 'Markdown (.md)' },
  { value: 'URL',      label: 'Enlace Web' },
];

export default function GestionUnidad({ email, nombreAsignatura, unidad, onBack }: GestionUnidadProps) {
  const isEditing = !!unidad;

  const [name, setName]               = useState(unidad?.nombre_unidad || '');
  const [description, setDescription] = useState(unidad?.descripcion || '');
  const [tipoArchivo, setTipoArchivo] = useState<TipoArchivo>(unidad?.tipo_archivo || 'PDF');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [urlInput, setUrlInput]       = useState(
    unidad?.tipo_archivo === 'URL' ? unidad.nombre_archivo : ''
  );
  const [isSaving, setIsSaving]         = useState(false);
  const [saveProgress, setSaveProgress] = useState(0);
  const [error, setError]               = useState('');
  const [flaskWarning, setFlaskWarning] = useState(false);

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const acceptMap: Record<TipoArchivo, string> = {
    PDF:      '.pdf',
    Markdown: '.md,.markdown',
    URL:      '',
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    const file = e.target.files[0];
    if (tipoArchivo === 'PDF' && file.type !== 'application/pdf') {
      setError('Selecciona un archivo PDF válido.'); return;
    }
    setSelectedFile(file);
    setError('');
  };

  const handleTipoChange = (tipo: TipoArchivo) => {
    if (isEditing) return; // no cambiar tipo al editar
    setTipoArchivo(tipo);
    setSelectedFile(null);
    setUrlInput('');
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const previewFile = async (file: File) => {
    const url = URL.createObjectURL(file);
    window.open(url, '_blank');
  };

  const handlePreviewExistente = async () => {
    if (!unidad) return;
    if (unidad.tipo_archivo === 'URL') {
      window.open(unidad.nombre_archivo, '_blank');
      return;
    }
    const key = `${email}/${nombreAsignatura}/${unidad.nombre_unidad}/${unidad.nombre_archivo}`;
    const url = await s3PresignedUrl(key, 3600);
    window.open(url, '_blank');
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // URL del backend Flask (configurable vía variable de entorno)
  const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:5000';

  const handleSave = async () => {
    setError('');
    if (!name.trim())        { setError('El nombre de la unidad es obligatorio.'); return; }
    if (!description.trim()) { setError('La descripción es obligatoria.'); return; }

    const needsNewFile = !isEditing || selectedFile !== null;

    if (tipoArchivo !== 'URL' && needsNewFile && !selectedFile) {
      setError(`Debes seleccionar un archivo ${tipoArchivo === 'PDF' ? 'PDF' : 'Markdown'}.`); return;
    }
    if (tipoArchivo === 'URL' && !urlInput.trim()) {
      setError('Debes introducir una URL válida.'); return;
    }

    setIsSaving(true);
    setSaveProgress(10);

    try {
      const now            = new Date().toISOString();
      const rutaBase       = `${email}/${nombreAsignatura}/${name.trim()}/`;
      const detalleArchivo = `${nombreAsignatura}#${name.trim()}`;

      let nombreArchivo = unidad?.nombre_archivo ?? '';

      // 1. Subir nuevo archivo a S3 (si se seleccionó uno o es URL)
      setSaveProgress(20);

      if (tipoArchivo === 'URL') {
        const key = `${rutaBase}source.txt`;
        const res = await s3Upload(key, urlInput.trim(), 'text/plain');
        if (!res.ok) throw new Error(`S3 error ${res.status}`);
        nombreArchivo = urlInput.trim();
      } else if (selectedFile) {
        // Borrar archivo anterior si es edición y cambió el archivo
        if (isEditing && unidad!.nombre_archivo) {
          const oldKey = `${email}/${nombreAsignatura}/${unidad!.nombre_unidad}/${unidad!.nombre_archivo}`;
          await s3Delete(oldKey).catch(() => {}); // best-effort
        }
        const contentType = tipoArchivo === 'PDF' ? 'application/pdf' : 'text/markdown';
        const key         = `${rutaBase}${selectedFile.name}`;
        const bytes       = new Uint8Array(await selectedFile.arrayBuffer());
        const res         = await s3Upload(key, bytes, contentType);
        if (!res.ok) throw new Error(`S3 error ${res.status}`);
        nombreArchivo = selectedFile.name;
      }

      setSaveProgress(50);

      // 2. Guardar en DynamoDB (estado: pendiente)
      const nuevaUnidad: Unidad = {
        email,
        detalle_archivo:     detalleArchivo,
        nombre_asignatura:   nombreAsignatura,
        nombre_unidad:       name.trim(),
        descripcion:         description.trim(),
        fecha_creacion:      unidad?.fecha_creacion || now,
        fecha_actualizacion: now,
        estado:              'pendiente',
        ruta_s3:             `${BUCKET}/${rutaBase}`,
        tipo_archivo:        tipoArchivo,
        nombre_archivo:      nombreArchivo,
      };

      const result = await guardarUnidad(nuevaUnidad);
      if (result.error) { setError(result.error); return; }

      setSaveProgress(70);

      // 3. Llamar al backend Flask para generar el índice FAISS
      //    (esto puede tardar 15-30 seg según el tamaño del documento)
      const hayArchivoNuevo = tipoArchivo === 'URL' || selectedFile !== null;
      let flaskFailed = false;
      if (hayArchivoNuevo) {
        setSaveProgress(75);
        try {
          const ragRes = await fetch(`${API_URL}/procesar`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email,
              nombre_asignatura: nombreAsignatura,
              nombre_unidad:     name.trim(),
              tipo_archivo:      tipoArchivo,
              nombre_archivo:    nombreArchivo,
            }),
          });
          if (!ragRes.ok) {
            const ragBody = await ragRes.json().catch(() => ({}));
            console.warn('RAG backend error:', ragBody);
            flaskFailed = true;
            setFlaskWarning(true);
          }
        } catch (ragErr) {
          // Flask no disponible — el archivo queda en estado "pendiente"
          console.warn('Backend Flask no disponible. El índice RAG se generará más tarde:', ragErr);
          flaskFailed = true;
          setFlaskWarning(true);
        }
      }

      setSaveProgress(100);
      await new Promise(r => setTimeout(r, 400));
      // Si Flask falló mostramos el aviso en pantalla; el usuario vuelve manualmente
      if (!flaskFailed) onBack();
    } catch (err) {
      console.error(err);
      setError('Error guardando la unidad. Comprueba la consola.');
    } finally {
      setIsSaving(false);
      setSaveProgress(0);
    }
  };

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="border-b border-gray-100 px-8 py-4 sticky top-0 z-10 bg-white">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={onBack} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
              <ChevronLeft className="w-5 h-5 text-gray-500" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-gray-900">
                {isEditing ? `Editando: ${unidad.nombre_unidad}` : 'Crear nueva Unidad'}
              </h1>
              <p className="text-xs text-gray-400">{nombreAsignatura}</p>
            </div>
          </div>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-2 px-6 py-2 bg-tepro-orange text-white rounded-xl font-bold hover:bg-orange-700 transition-all shadow-sm disabled:opacity-60"
          >
            <Save className="w-4 h-4" />
            {isEditing ? 'Guardar Cambios' : 'Guardar Unidad'}
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-8 py-12">
        {error && (
          <div className="mb-6 p-4 bg-red-50 text-red-600 text-sm font-medium rounded-xl border border-red-100">
            {error}
          </div>
        )}

        {flaskWarning && (
          <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
            <span className="text-amber-500 text-xl leading-none mt-0.5">⚠️</span>
            <div className="flex-1">
              <p className="text-sm font-bold text-amber-800 mb-1">Unidad guardada — índice RAG pendiente</p>
              <p className="text-xs text-amber-700">
                El archivo se subió correctamente a S3 y los metadatos se guardaron en DynamoDB,
                pero el servidor Flask no está disponible en este momento. La unidad aparece como
                <strong> "pendiente"</strong>. Cuando arranques Flask ({API_URL}), el índice RAG
                se generará automáticamente en el próximo intento.
              </p>
              <button
                onClick={onBack}
                className="mt-3 px-4 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded-lg transition-colors"
              >
                Entendido, volver al listado
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
          {/* Left: Información general */}
          <div className="lg:col-span-1 space-y-8">
            <section>
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Información General</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">Nombre de la Unidad</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={isEditing}
                    placeholder="Ej. Tema 1: Introducción"
                    className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-tepro-orange/20 focus:border-tepro-orange disabled:cursor-not-allowed disabled:text-gray-400"
                  />
                  {isEditing && <p className="text-[10px] text-gray-400 mt-1">El nombre no puede modificarse una vez creada la unidad.</p>}
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">Descripción</label>
                  <textarea
                    rows={4}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe el contenido de esta unidad..."
                    className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-tepro-orange/20 focus:border-tepro-orange resize-none"
                  />
                </div>
              </div>
            </section>
          </div>

          {/* Right: Recurso */}
          <div className="lg:col-span-2 space-y-8">
            {/* Selector de tipo */}
            <section>
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Tipo de Recurso</h3>
              <div className="flex gap-3">
                {TIPOS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => handleTipoChange(value)}
                    disabled={isEditing}
                    className={`flex-1 py-3 rounded-xl font-semibold text-sm border-2 transition-all ${
                      tipoArchivo === value
                        ? 'border-tepro-orange bg-orange-50 text-tepro-orange'
                        : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                    } disabled:opacity-60 disabled:cursor-not-allowed`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {isEditing && <p className="text-[10px] text-gray-400 mt-2">El tipo de recurso no puede modificarse en una unidad ya creada.</p>}
            </section>

            {/* Archivo actual (modo edición) */}
            {isEditing && unidad.nombre_archivo && (
              <section>
                <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Archivo Actual</h3>
                <div className="bg-orange-50/60 border border-orange-100 rounded-2xl p-5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center shadow-sm">
                      {tipoArchivo === 'URL'
                        ? <Link className="w-5 h-5 text-tepro-orange" />
                        : <FileText className="w-5 h-5 text-tepro-orange" />}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-800 break-all max-w-xs">
                        {tipoArchivo === 'URL' ? unidad.nombre_archivo : unidad.nombre_archivo}
                      </p>
                      <p className="text-[10px] text-gray-400 uppercase tracking-wider">{tipoArchivo}</p>
                    </div>
                  </div>
                  <button
                    onClick={handlePreviewExistente}
                    className="flex items-center gap-2 px-4 py-2 text-tepro-orange border border-tepro-orange/30 hover:bg-tepro-orange hover:text-white rounded-xl text-xs font-bold transition-all"
                  >
                    <ExternalLink className="w-3 h-3" />
                    {tipoArchivo === 'URL' ? 'Abrir enlace' : 'Ver archivo'}
                  </button>
                </div>
              </section>
            )}

            {/* Uploader nuevo (PDF / Markdown) */}
            {tipoArchivo !== 'URL' && (
              <section>
                <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">
                  {isEditing ? 'Reemplazar archivo' : `Subir ${tipoArchivo === 'PDF' ? 'PDF' : 'Markdown'}`}
                </h3>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-gray-200 rounded-2xl p-10 flex flex-col items-center justify-center text-center hover:border-tepro-orange hover:bg-orange-50/50 transition-all cursor-pointer group"
                >
                  <div className="w-14 h-14 bg-gray-50 rounded-full flex items-center justify-center mb-4 group-hover:bg-orange-50 transition-colors">
                    <Upload className="w-7 h-7 text-gray-400 group-hover:text-tepro-orange" />
                  </div>
                  <h4 className="text-base font-semibold text-gray-900 mb-1">
                    {isEditing ? 'Subir nuevo archivo para reemplazar' : `Sube el archivo ${tipoArchivo === 'PDF' ? 'PDF' : 'Markdown'}`}
                  </h4>
                  <p className="text-sm text-gray-500">
                    {isEditing ? 'Si no seleccionas ninguno, se conserva el actual.' : 'Solo se permite un archivo por unidad.'}
                  </p>
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    accept={acceptMap[tipoArchivo]}
                    className="hidden"
                  />
                </div>

                {/* Archivo nuevo seleccionado */}
                {selectedFile && (
                  <div className="mt-4 bg-white border border-gray-100 rounded-2xl overflow-hidden shadow-sm">
                    <div className="px-6 py-4 flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center">
                          <FileText className="w-5 h-5 text-gray-400" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-gray-800">{selectedFile.name}</p>
                          <p className="text-[10px] text-gray-400 uppercase tracking-wider">{formatSize(selectedFile.size)}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => previewFile(selectedFile)} className="p-2 text-gray-400 hover:text-tepro-orange hover:bg-orange-50 rounded-lg transition-all">
                          <Eye className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => { setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                          className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* Input URL */}
            {tipoArchivo === 'URL' && (
              <section>
                <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Enlace Web</h3>
                <div className="relative">
                  <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                    <Link className="w-4 h-4 text-gray-400" />
                  </div>
                  <input
                    type="url"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder="https://ejemplo.com/página"
                    className="w-full pl-12 pr-4 py-4 bg-gray-50 border border-gray-200 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-tepro-orange/20 focus:border-tepro-orange"
                  />
                </div>
                <p className="text-[11px] text-gray-400 mt-2">
                  La URL se guardará para ser procesada cuando se genere el índice RAG.
                </p>
              </section>
            )}
          </div>
        </div>
      </main>

      {/* Progress toast */}
      {isSaving && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="fixed bottom-8 right-8 w-80 bg-white border border-gray-200 rounded-2xl shadow-2xl p-6 z-50"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-orange-50 rounded-full flex items-center justify-center">
              <RefreshCw className="w-5 h-5 text-tepro-orange animate-spin" />
            </div>
            <div>
              <h5 className="text-sm font-bold text-gray-900">Guardando Unidad</h5>
              <p className="text-xs text-gray-400">
                {saveProgress < 50  && 'Subiendo archivo a S3...'}
                {saveProgress >= 50 && saveProgress < 70  && 'Guardando metadatos...'}
                {saveProgress >= 70 && saveProgress < 100 && '🧠 Generando índice RAG (puede tardar)...'}
                {saveProgress === 100 && '¡Listo!'}
              </p>
            </div>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-1.5 mb-2">
            <div className="bg-tepro-orange h-1.5 rounded-full transition-all duration-300" style={{ width: `${saveProgress}%` }} />
          </div>
          <p className="text-[10px] text-right text-gray-400 font-bold">{saveProgress}% completado</p>
        </motion.div>
      )}
    </div>
  );
}
