"""
Voice Quizzer — Backend Flask (RAG Processor)
==============================================
Expone un único endpoint:
    POST /procesar  →  descarga el archivo de S3, genera el índice FAISS
                       y lo sube a  .../index/index.faiss + index.pkl

Cómo arrancar:
    cd backend
    pip install -r requirements.txt
    python api.py

Requiere un archivo .env en esta carpeta con:
    AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_BUCKET_NAME
"""

import os
import json
import tempfile
import shutil
from datetime import datetime

import boto3
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

# Librerías RAG (igual que app.py original)
from langchain_community.document_loaders import PyPDFLoader, WebBaseLoader, TextLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_community.vectorstores import FAISS

# ── Configuración ─────────────────────────────────────────────────────────────
load_dotenv()

AWS_REGION     = os.getenv('AWS_REGION', 'eu-west-3')
BUCKET         = os.getenv('AWS_BUCKET_NAME', 'voice-quizzer-maria')

s3_client  = boto3.client(
    's3',
    region_name            = AWS_REGION,
    aws_access_key_id      = os.getenv('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key  = os.getenv('AWS_SECRET_ACCESS_KEY'),
)

dynamodb       = boto3.resource(
    'dynamodb',
    region_name            = AWS_REGION,
    aws_access_key_id      = os.getenv('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key  = os.getenv('AWS_SECRET_ACCESS_KEY'),
)
tabla_unidades = dynamodb.Table('VQ_Unidad')

# ── Flask ─────────────────────────────────────────────────────────────────────
app = Flask(__name__)

# Permite peticiones desde el frontend React
CORS(app, origins=[
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
])


# ── Endpoint principal ────────────────────────────────────────────────────────

@app.route('/procesar', methods=['POST'])
def procesar():
    """
    Body JSON esperado:
    {
        "email":              "maria@ejemplo.com",
        "nombre_asignatura":  "Matemáticas",
        "nombre_unidad":      "Tema 1",
        "tipo_archivo":       "PDF" | "Markdown" | "URL",
        "nombre_archivo":     "apuntes.pdf" | "notas.md" | "https://..."
    }
    """
    data = request.get_json(force=True)
    email             = data.get('email', '').strip()
    nombre_asignatura = data.get('nombre_asignatura', '').strip()
    nombre_unidad     = data.get('nombre_unidad', '').strip()
    tipo_archivo      = data.get('tipo_archivo', 'PDF')
    nombre_archivo    = data.get('nombre_archivo', '').strip()

    if not all([email, nombre_asignatura, nombre_unidad]):
        return jsonify({'error': 'Faltan campos obligatorios.'}), 400

    ruta_base    = f"{email}/{nombre_asignatura}/{nombre_unidad}/"
    index_prefix = f"{ruta_base}index/"

    print(f"\n[{datetime.now().isoformat()}] Procesando: {ruta_base} ({tipo_archivo})")

    try:
        # 1. Cargar documentos
        docs = _cargar_documentos(ruta_base, tipo_archivo, nombre_archivo)
        if not docs:
            return jsonify({'error': 'No se pudieron cargar documentos del archivo.'}), 422

        print(f"  → {len(docs)} página(s) cargada(s)")

        # 2. Generar índice FAISS y subir a S3
        _generar_y_subir_index(docs, index_prefix)

        # 3. Actualizar estado en DynamoDB: pendiente → listo
        _actualizar_estado(email, nombre_asignatura, nombre_unidad)

        print(f"  ✓ Índice subido a s3://{BUCKET}/{index_prefix}")
        return jsonify({'ok': True})

    except Exception as exc:
        print(f"  ✗ Error: {exc}")
        return jsonify({'error': str(exc)}), 500


# ── Helpers internos ──────────────────────────────────────────────────────────

def _cargar_documentos(ruta_base, tipo_archivo, nombre_archivo):
    """Descarga el archivo de S3 (o carga la URL) y devuelve los documentos LangChain."""

    if tipo_archivo == 'URL':
        # La URL está en nombre_archivo (guardada en DynamoDB por el frontend)
        url = nombre_archivo
        if not url:
            # Fallback: leerla del source.txt subido a S3
            obj = s3_client.get_object(Bucket=BUCKET, Key=f"{ruta_base}source.txt")
            url = obj['Body'].read().decode('utf-8').strip()
        print(f"  → Cargando URL: {url}")
        return WebBaseLoader(url).load()

    # PDF o Markdown: descargar de S3 a /tmp
    s3_key = f"{ruta_base}{nombre_archivo}"
    ext    = nombre_archivo.rsplit('.', 1)[-1].lower() if '.' in nombre_archivo else 'bin'

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=f'.{ext}')
    os.close(tmp_fd)

    try:
        print(f"  → Descargando s3://{BUCKET}/{s3_key}")
        s3_client.download_file(BUCKET, s3_key, tmp_path)

        if tipo_archivo == 'PDF':
            return PyPDFLoader(tmp_path).load()
        else:   # Markdown
            return TextLoader(tmp_path, encoding='utf-8').load()
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def _generar_y_subir_index(docs, index_prefix):
    """Fragmenta, vectoriza con HuggingFace y sube index.faiss + index.pkl + chunks.json a S3."""

    # Dividir en chunks
    splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
    chunks   = splitter.split_documents(docs)
    print(f"  → {len(chunks)} chunks generados")

    # Guardar chunks.json (texto en bruto para uso de la Lambda de Alexa)
    chunks_text = [c.page_content for c in chunks]
    chunks_json = json.dumps(chunks_text, ensure_ascii=False).encode('utf-8')
    chunks_key  = f"{index_prefix}chunks.json"
    s3_client.put_object(Bucket=BUCKET, Key=chunks_key, Body=chunks_json, ContentType='application/json')
    print(f"  → Subido: {chunks_key}")

    # Embeddings semánticos (all-MiniLM-L6-v2 vía sentence-transformers)
    embeddings  = HuggingFaceEmbeddings(model_name='all-MiniLM-L6-v2')
    vectorstore = FAISS.from_documents(chunks, embeddings)

    # Guardar index.faiss + index.pkl en carpeta temporal y subir a S3
    tmp_dir = tempfile.mkdtemp()
    try:
        vectorstore.save_local(tmp_dir)
        for fname in os.listdir(tmp_dir):
            local_path = os.path.join(tmp_dir, fname)
            s3_key     = f"{index_prefix}{fname}"
            s3_client.upload_file(local_path, BUCKET, s3_key)
            print(f"  → Subido: {s3_key}")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _actualizar_estado(email, nombre_asignatura, nombre_unidad):
    """Marca la unidad como 'listo' en DynamoDB."""
    id_unidad       = f"{email}#{nombre_asignatura}#{nombre_unidad}"
    detalle_archivo = f"{nombre_asignatura}#{nombre_unidad}"

    tabla_unidades.update_item(
        Key={
            'id_unidad':       id_unidad,
            'detalle_archivo': detalle_archivo,
        },
        UpdateExpression='SET estado = :s',
        ExpressionAttributeValues={':s': 'listo'},
    )


# ── Arranque ──────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print("Voice Quizzer API arrancando en http://localhost:5000")
    app.run(host='0.0.0.0', port=5000, debug=True)
