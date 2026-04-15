"""
Voice Quizzer — Alexa Skill Lambda Handler
==========================================
Sin dependencias externas: usa urllib (built-in) para llamar a Groq API
y boto3 (built-in en Lambda) para DynamoDB y S3.

Variables de entorno requeridas:
  GROQ_API_KEY, AWS_BUCKET_NAME, AWS_REGION_NAME
"""

import os
import json
import uuid
import urllib.request
from datetime import datetime

import boto3
from boto3.dynamodb.conditions import Attr

# ── Clientes AWS ──────────────────────────────────────────────────────────────

REGION = os.environ.get('AWS_REGION_NAME', 'eu-west-3')
BUCKET = os.environ.get('AWS_BUCKET_NAME', 'voice-quizzer-maria')

dynamodb = boto3.resource('dynamodb', region_name=REGION)
s3       = boto3.client('s3', region_name=REGION)

tabla_usuarios  = dynamodb.Table('VQ_Usuarios')
tabla_unidades  = dynamodb.Table('VQ_Unidad')
tabla_historial = dynamodb.Table('VQ_Historial')

# Caché en /tmp: persiste entre invocaciones "calientes"
_chunks_cache: dict = {}


# ── Groq API (urllib, sin librerías externas) ─────────────────────────────────

def _groq(messages, temperature=0.4, max_tokens=4000):
    """Llama a AWS Bedrock (Llama 3) usando boto3 — sin bloqueos, dentro de AWS."""

    bedrock = boto3.client('bedrock-runtime', region_name='eu-west-1')

    # Convertir formato OpenAI → formato Bedrock Converse API
    system_content = []
    conv_messages  = []
    for m in messages:
        if m['role'] == 'system':
            system_content.append({'text': m['content']})
        else:
            conv_messages.append({
                'role':    m['role'],
                'content': [{'text': m['content']}],
            })

    # Si no hay mensajes de usuario, añadir uno vacío para evitar error
    if not conv_messages:
        conv_messages = [{'role': 'user', 'content': [{'text': 'Hola'}]}]

    kwargs = {
        'modelId':           'meta.llama3-8b-instruct-v1:0',
        'messages':          conv_messages,
        'inferenceConfig':   {
            'maxTokens':   max_tokens,
            'temperature': temperature,
        },
    }
    if system_content:
        kwargs['system'] = system_content

    try:
        resp   = bedrock.converse(**kwargs)
        texto  = resp['output']['message']['content'][0]['text']
        print(f"[BEDROCK DEBUG] Respuesta recibida, longitud: {len(texto)}")
        return texto.strip()
    except Exception as e:
        print(f"[BEDROCK DEBUG] Error: {e}")
        raise


# ── Handler principal ─────────────────────────────────────────────────────────

def handler(event, context):
    req_type = event['request']['type']

    if req_type == 'LaunchRequest':
        return _handle_launch(event)
    elif req_type == 'IntentRequest':
        return _handle_intent(event)
    elif req_type == 'SessionEndedRequest':
        return _resp("Hasta luego.", end=True)

    return _resp("No entendí eso. Inténtalo de nuevo.")


# ── LaunchRequest ─────────────────────────────────────────────────────────────

def _handle_launch(event):
    device_id = event['context']['System']['device']['deviceId']
    user      = _get_user_by_device(device_id)

    if user:
        nombre      = user.get('nombre_usuario', 'estudiante')
        email       = user['email']
        asignaturas = _get_asignaturas(email)

        if not asignaturas:
            return _resp(
                f"Hola {nombre}. Todavía no tienes asignaturas en Voice Quizzer. "
                "Añade una desde la aplicación web y vuelve aquí. ¡Hasta pronto!",
                end=True
            )

        msg = f"¡Qué alegría verte de nuevo, {nombre}! ¿Qué asignatura quieres estudiar? "
        for i, a in enumerate(asignaturas, 1):
            msg += f"Número {i}, {a}. "
        msg += "Di el número."

        return _resp(msg, attrs={
            'estado':      'eligiendo_asignatura',
            'email':       email,
            'nombre':      nombre,
            'asignaturas': asignaturas,
        })

    return _resp(
        "Bienvenido a Voice Quizzer. "
        "Para vincular tu cuenta, dime tu código de seis dígitos. "
        "Lo encontrarás en tu perfil de la aplicación web.",
        attrs={'estado': 'esperando_pin'}
    )


# ── IntentRequest ─────────────────────────────────────────────────────────────

def _handle_intent(event):
    name   = event['request']['intent']['name']
    slots  = event['request']['intent'].get('slots', {})
    attrs  = event.get('session', {}).get('attributes', {}) or {}
    estado = attrs.get('estado', '')

    # Stop/Cancel siempre funcionan independientemente del estado
    if name in ('AMAZON.StopIntent', 'AMAZON.CancelIntent'):
        return _resp("Hasta luego.", end=True)

    val = _primer_slot(slots)

    # ── Routing por estado (tiene prioridad sobre el nombre del intent) ────────
    # Así evitamos que Alexa enrute erróneamente el PIN o las respuestas
    # a intents equivocados (FinalizarIntent, ResponderIntent, etc.)

    if estado == 'esperando_pin':
        if not val:
            # Alexa no capturó ningún número — pedir que lo repita
            return _resp(
                "No escuché tu código correctamente. "
                "Di 'mi código es' seguido de los seis dígitos, por ejemplo: "
                "mi código es ciento veintitrés mil cuatrocientos cincuenta y seis.",
                attrs=attrs
            )
        return _vincular(event, attrs, {'pin': {'value': val}})

    if estado in ('eligiendo_asignatura', 'eligiendo_unidad', 'eligiendo_num_preguntas'):
        return _numero(attrs, {'numero': {'value': val}})

    if estado == 'eligiendo_tipo':
        return _tipo(attrs, {'tipo': {'value': val}})

    if estado == 'eligiendo_modo':
        return _modo(attrs, {'modo': {'value': val}})

    if estado == 'en_cuestionario':
        if name == 'FinalizarIntent':
            return _finalizar(attrs)
        if name == 'AMAZON.YesIntent':
            return _yes(attrs)
        if name == 'AMAZON.NoIntent':
            return _no(attrs)
        return _evaluar_respuesta(attrs, val)

    if estado == 'preguntando_continuar':
        if name == 'AMAZON.YesIntent':
            return _yes(attrs)
        if name == 'AMAZON.NoIntent':
            return _no(attrs)
        return _resp("¿Quieres estudiar otra cosa? Di sí o no.", attrs=attrs)

    # ── Intents globales cuando no hay estado activo ───────────────────────────
    if name == 'FinalizarIntent':
        return _finalizar(attrs)
    if name == 'AMAZON.YesIntent':
        return _yes(attrs)
    if name == 'AMAZON.NoIntent':
        return _no(attrs)
    if name == 'AMAZON.HelpIntent':
        return _resp(
            "Puedes decir el número de la opción que quieras elegir, "
            "o 'finalizar' para salir del cuestionario.", attrs=attrs
        )

    # ── Fallback: dispatch por nombre de intent ────────────────────────────────
    dispatch = {
        'VincularCuentaIntent':    lambda: _vincular(event, attrs, slots),
        'SeleccionarNumeroIntent': lambda: _numero(attrs, slots),
        'SeleccionarTipoIntent':   lambda: _tipo(attrs, slots),
        'SeleccionarModoIntent':   lambda: _modo(attrs, slots),
        'ResponderIntent':         lambda: _evaluar(attrs, slots),
    }
    fn = dispatch.get(name)
    if fn:
        return fn()
    return _resp("No entendí. Inténtalo de nuevo.", attrs=attrs)


def _primer_slot(slots):
    """Devuelve el valor del primer slot que tenga contenido."""
    for slot in slots.values():
        if slot and slot.get('value'):
            return str(slot['value'])
    return ''


_NUMEROS_ES = {
    'cero': 0, 'uno': 1, 'una': 1, 'dos': 2, 'tres': 3, 'cuatro': 4,
    'cinco': 5, 'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10,
    'once': 11, 'doce': 12, 'trece': 13, 'catorce': 14, 'quince': 15,
    'dieciséis': 16, 'dieciseis': 16, 'diecisiete': 17, 'dieciocho': 18,
    'diecinueve': 19, 'veinte': 20,
}

def _extraer_numero(texto):
    """Intenta extraer un número de un texto en español.
    Primero prueba conversión directa, luego busca palabras numéricas."""
    if not texto:
        return None
    # Intentar conversión directa (Alexa ya lo convirtió a dígito)
    try:
        return int(float(str(texto).strip()))
    except (ValueError, TypeError):
        pass
    # Buscar palabras numéricas en el texto
    texto_lower = str(texto).lower().strip()
    for palabra, valor in _NUMEROS_ES.items():
        if palabra in texto_lower:
            return valor
    return None


# ── Intents ───────────────────────────────────────────────────────────────────

def _vincular(event, attrs, slots):
    pin_raw   = (slots.get('pin') or {}).get('value', '') or ''
    pin       = str(pin_raw).replace(' ', '').strip()
    device_id = event['context']['System']['device']['deviceId']

    if len(pin) != 6 or not pin.isdigit():
        return _resp(
            "No escuché bien los seis dígitos. "
            "Por favor, dime tu código de seis dígitos.",
            attrs=attrs
        )

    user = _get_user_by_pin(pin)
    if not user:
        return _resp(
            "Código incorrecto. Revísalo en la sección de perfil de la aplicación web.",
            attrs=attrs
        )

    email  = user['email']
    nombre = user.get('nombre_usuario', 'estudiante')
    _link_device(email, device_id)

    asignaturas = _get_asignaturas(email)
    if not asignaturas:
        return _resp(
            f"Cuenta vinculada. Hola {nombre}. "
            "Todavía no tienes asignaturas. Añade una desde la app y vuelve. ¡Hasta pronto!",
            end=True
        )

    msg = f"Cuenta vinculada correctamente. Hola {nombre}. "
    msg += "¿Qué asignatura quieres estudiar? "
    for i, a in enumerate(asignaturas, 1):
        msg += f"Número {i}, {a}. "
    msg += "Di el número."

    return _resp(msg, attrs={
        'estado':      'eligiendo_asignatura',
        'email':       email,
        'nombre':      nombre,
        'asignaturas': asignaturas,
    })


def _numero(attrs, slots):
    val    = (slots.get('numero') or {}).get('value', '')
    estado = attrs.get('estado', '')

    num = _extraer_numero(val)
    if num is None:
        return _resp("No entendí el número. Repite por favor.", attrs=attrs)

    if estado == 'eligiendo_asignatura':
        lista = attrs.get('asignaturas', [])
        if num < 1 or num > len(lista):
            return _resp(f"Elige un número entre 1 y {len(lista)}.", attrs=attrs)

        asignatura = lista[num - 1]
        email      = attrs['email']
        unidades   = _get_unidades(email, asignatura)

        if not unidades:
            return _resp(
                f"La asignatura {asignatura} aún no tiene unidades procesadas. "
                "Asegúrate de que su estado es 'listo' en la aplicación web.",
                attrs=attrs
            )

        msg = f"Has elegido {asignatura}. ¿Qué unidad quieres estudiar? "
        for i, u in enumerate(unidades, 1):
            msg += f"Número {i}, {u}. "
        msg += "Di el número."

        attrs.update({'estado': 'eligiendo_unidad', 'asignatura': asignatura, 'unidades': unidades})
        return _resp(msg, attrs=attrs)

    elif estado == 'eligiendo_unidad':
        lista = attrs.get('unidades', [])
        if num < 1 or num > len(lista):
            return _resp(f"Elige un número entre 1 y {len(lista)}.", attrs=attrs)

        unidad = lista[num - 1]
        attrs.update({'estado': 'eligiendo_tipo', 'unidad': unidad})
        return _resp(
            f"Has elegido {unidad}. ¿Quieres hacer un test o un cuestionario de desarrollo?",
            attrs=attrs
        )

    elif estado == 'eligiendo_num_preguntas':
        if num < 1 or num > 20:
            return _resp("Elige un número entre 1 y 20.", attrs=attrs)
        attrs['num_preguntas'] = num
        return _generar_cuestionario(attrs)

    return _resp("No entendí. Repite el número.", attrs=attrs)


def _tipo(attrs, slots):
    val = (slots.get('tipo') or {}).get('value', '').lower()

    if 'test' in val:
        attrs.update({'tipo': 'test', 'estado': 'eligiendo_num_preguntas'})
        return _resp("Modo test. ¿Cuántas preguntas quieres? Entre 1 y 20.", attrs=attrs)

    elif 'desarrollo' in val or 'abierta' in val:
        attrs.update({'tipo': 'desarrollo', 'estado': 'eligiendo_modo'})
        return _resp(
            "Modo desarrollo. ¿Quieres modo fácil o modo difícil? "
            "En el fácil recibirás una pequeña pista tras cada pregunta.",
            attrs=attrs
        )

    return _resp("Di 'test' o 'desarrollo'.", attrs=attrs)


def _modo(attrs, slots):
    val = (slots.get('modo') or {}).get('value', '').lower()

    if any(x in val for x in ['facil', 'fácil', 'sencillo', 'easy']):
        attrs.update({'modo': 'facil', 'estado': 'eligiendo_num_preguntas'})
    elif any(x in val for x in ['dificil', 'difícil', 'hard', 'complicado']):
        attrs.update({'modo': 'dificil', 'estado': 'eligiendo_num_preguntas'})
    else:
        return _resp("Di 'fácil' o 'difícil'.", attrs=attrs)

    return _resp("¿Cuántas preguntas quieres? Entre 1 y 20.", attrs=attrs)


def _evaluar(attrs, slots):
    respuesta = (slots.get('respuesta') or {}).get('value', '') or ''
    return _evaluar_respuesta(attrs, respuesta)


def _finalizar(attrs):
    if attrs.get('estado') != 'en_cuestionario':
        return _resp("No hay ningún cuestionario activo.", end=True)
    attrs['confirmando_salida'] = True
    return _resp("¿Estás seguro? Tu progreso no se guardará.", attrs=attrs)


def _yes(attrs):
    if attrs.get('confirmando_salida'):
        return _resp("De acuerdo. Tu progreso no se ha guardado. ¡Hasta pronto!", end=True)

    if attrs.get('estado') == 'preguntando_continuar':
        # El usuario quiere estudiar otra cosa → volver a elegir asignatura
        email       = attrs['email']
        nombre      = attrs['nombre']
        asignaturas = _get_asignaturas(email)
        msg = f"¡Perfecto! ¿Qué asignatura quieres estudiar ahora? "
        for i, a in enumerate(asignaturas, 1):
            msg += f"Número {i}, {a}. "
        msg += "Di el número."
        return _resp(msg, attrs={
            'estado':      'eligiendo_asignatura',
            'email':       email,
            'nombre':      nombre,
            'asignaturas': asignaturas,
        })

    return _evaluar_respuesta(attrs, 'sí')


def _no(attrs):
    if attrs.get('confirmando_salida'):
        attrs.pop('confirmando_salida', None)
        idx   = attrs.get('pregunta_actual', 0)
        preg  = attrs['preguntas'][idx]
        total = len(attrs['preguntas'])
        msg   = f"Continuamos. Pregunta {idx + 1} de {total}: {preg['pregunta']}. "
        if attrs.get('tipo') == 'test':
            o = preg['opciones']
            msg += f"A: {o['A']}. B: {o['B']}. C: {o['C']}."
        elif attrs.get('modo') == 'facil' and preg.get('pista'):
            msg += f"Pista: {preg['pista']}."
        return _resp(msg, attrs=attrs)

    if attrs.get('estado') == 'preguntando_continuar':
        nombre = attrs.get('nombre', 'estudiante')
        return _resp(
            f"¡Muy bien, {nombre}! Ha sido un placer estudiar contigo. ¡Hasta pronto!",
            end=True
        )

    return _evaluar_respuesta(attrs, 'no')


# ── Lógica del cuestionario ───────────────────────────────────────────────────

def _generar_cuestionario(attrs):
    email      = attrs['email']
    asignatura = attrs['asignatura']
    unidad     = attrs['unidad']
    tipo       = attrs['tipo']
    modo       = attrs.get('modo', 'normal')
    n          = attrs['num_preguntas']

    # Cargar chunks desde S3 (con caché en /tmp)
    cache_key = f"{email}/{asignatura}/{unidad}"
    if cache_key not in _chunks_cache:
        s3_key = f"{email}/{asignatura}/{unidad}/index/chunks.json"
        try:
            obj    = s3.get_object(Bucket=BUCKET, Key=s3_key)
            chunks = json.loads(obj['Body'].read().decode('utf-8'))
            _chunks_cache[cache_key] = '\n\n'.join(chunks[:25])
        except Exception as exc:
            print(f"Error cargando chunks: {exc}")
            return _resp(
                "No pude cargar el contenido de esta unidad. "
                "Asegúrate de que su estado es 'listo' en la app web "
                "y vuelve a guardarla para regenerar el índice.",
                end=True
            )

    contexto = _chunks_cache[cache_key]

    if tipo == 'test':
        prompt = (
            f"Eres un profesor. Genera exactamente {n} preguntas de tipo test en español, "
            f"basándote SOLO en este contenido:\n\n{contexto}\n\n"
            "Cada pregunta tiene EXACTAMENTE 3 opciones: A, B y C. "
            "RESPONDE ÚNICAMENTE CON JSON VÁLIDO, sin texto adicional, sin markdown:\n"
            '[{"pregunta":"¿...?","opciones":{"A":"...","B":"...","C":"..."},'
            '"correcta":"A","explicacion":"La respuesta es A porque..."}]'
        )
    else:
        pista_str = (
            'Incluye una pista breve (máximo 15 palabras) en el campo "pista".'
            if modo == 'facil'
            else 'El campo "pista" déjalo en cadena vacía "".'
        )
        prompt = (
            f"Eres un profesor. Genera exactamente {n} preguntas de desarrollo en español, "
            f"basándote SOLO en este contenido:\n\n{contexto}\n\n{pista_str}\n\n"
            "RESPONDE ÚNICAMENTE CON JSON VÁLIDO, sin texto adicional, sin markdown:\n"
            '[{"pregunta":"Explica...","respuesta_modelo":"La respuesta es...","palabras_clave":["p1","p2"],"pista":"..."}]'
        )

    try:
        raw = _groq([{'role': 'user', 'content': prompt}], temperature=0.4, max_tokens=4000)
        if '```' in raw:
            raw = raw.split('```')[1]
            if raw.startswith('json'):
                raw = raw[4:]
            raw = raw.strip()
        preguntas = json.loads(raw)
    except Exception as exc:
        print(f"Error generando preguntas: {exc}")
        return _resp("Hubo un error generando las preguntas. Inténtalo de nuevo.", end=True)

    if len(preguntas) < n:
        preguntas = (preguntas * (n // len(preguntas) + 1))[:n]
    preguntas = preguntas[:n]

    attrs.update({
        'estado':          'en_cuestionario',
        'preguntas':       preguntas,
        'pregunta_actual': 0,
        'aciertos':        0,
    })

    primera = preguntas[0]
    msg = f"Perfecto. Empezamos. Pregunta 1 de {n}: {primera['pregunta']} "
    if tipo == 'test':
        o = primera['opciones']
        msg += f"A: {o['A']}. B: {o['B']}. C: {o['C']}."
    elif modo == 'facil' and primera.get('pista'):
        msg += f"Pista: {primera['pista']}."

    return _resp(msg, attrs=attrs)


def _evaluar_respuesta(attrs, respuesta_val):
    if attrs.get('estado') != 'en_cuestionario':
        return _resp("No hay ningún cuestionario activo.", attrs=attrs)

    preguntas = attrs.get('preguntas', [])
    idx       = attrs.get('pregunta_actual', 0)
    tipo      = attrs.get('tipo', 'test')
    aciertos  = attrs.get('aciertos', 0)
    pregunta  = preguntas[idx]

    if tipo == 'test':
        letra    = str(respuesta_val).strip().upper()[:1]
        correcta = pregunta['correcta'].upper()
        if letra == correcta:
            aciertos += 1
            feedback = f"¡Correcto! {pregunta.get('explicacion', '')}"
        else:
            feedback = (
                f"Incorrecto. La respuesta correcta era {correcta}: "
                f"{pregunta['opciones'].get(correcta, '')}. "
                f"{pregunta.get('explicacion', '')}"
            )
    else:
        eval_prompt = (
            "Evalúa si la respuesta del alumno es correcta. Responde SOLO con JSON.\n\n"
            f"Pregunta: {pregunta['pregunta']}\n"
            f"Respuesta modelo: {pregunta['respuesta_modelo']}\n"
            f"Palabras clave: {', '.join(pregunta.get('palabras_clave', []))}\n"
            f"Respuesta del alumno: {respuesta_val}\n\n"
            'JSON: {"correcto": true, "explicacion": "máximo 25 palabras"}'
        )
        try:
            raw = _groq([{'role': 'user', 'content': eval_prompt}], temperature=0.1, max_tokens=150)
            if '```' in raw:
                raw = raw.split('```')[1]
                if raw.startswith('json'):
                    raw = raw[4:]
            data        = json.loads(raw.strip())
            es_ok       = data.get('correcto', False)
            explicacion = data.get('explicacion', '')
            if es_ok:
                aciertos += 1
                feedback = f"¡Correcto! {explicacion}"
            else:
                feedback = f"Incorrecto. {explicacion} La respuesta era: {pregunta['respuesta_modelo'][:80]}."
        except Exception as exc:
            print(f"Error evaluando: {exc}")
            feedback = "No pude evaluar tu respuesta. Continuamos."

    idx += 1
    n   = len(preguntas)

    if idx >= n:
        _guardar_historial(
            email      = attrs['email'],
            asignatura = attrs['asignatura'],
            unidad     = attrs['unidad'],
            tipo       = tipo,
            n          = n,
            aciertos   = aciertos,
        )
        pct  = round(aciertos / n * 100)
        nota = ("¡Excelente resultado!" if pct >= 80
                else "Buen trabajo, sigue practicando." if pct >= 60
                else "Necesitas repasar este tema. ¡Ánimo!")
        # Limpiar datos del cuestionario pero mantener email/nombre para continuar
        attrs.update({
            'estado':    'preguntando_continuar',
            'preguntas': [],
            'pregunta_actual': 0,
            'aciertos':  0,
        })
        attrs.pop('asignatura', None)
        attrs.pop('unidad', None)
        attrs.pop('tipo', None)
        attrs.pop('modo', None)
        attrs.pop('num_preguntas', None)
        return _resp(
            f"{feedback} ¡Cuestionario completado! "
            f"Has acertado {aciertos} de {n} preguntas, un {pct} por ciento. "
            f"{nota} Tus resultados se han guardado. "
            "¿Quieres estudiar otra cosa?",
            attrs=attrs
        )

    attrs.update({'pregunta_actual': idx, 'aciertos': aciertos, 'preguntas': preguntas})
    siguiente = preguntas[idx]
    msg = f"{feedback} Pregunta {idx + 1} de {n}: {siguiente['pregunta']} "
    if tipo == 'test':
        o = siguiente['opciones']
        msg += f"A: {o['A']}. B: {o['B']}. C: {o['C']}."
    elif attrs.get('modo') == 'facil' and siguiente.get('pista'):
        msg += f"Pista: {siguiente['pista']}."

    return _resp(msg, attrs=attrs)


# ── DynamoDB helpers ──────────────────────────────────────────────────────────

def _get_user_by_device(device_id):
    try:
        res   = tabla_usuarios.scan(FilterExpression=Attr('alexa_user_id').eq(device_id))
        items = res.get('Items', [])
        return items[0] if items else None
    except Exception as e:
        print(f"_get_user_by_device error: {e}")
        return None


def _get_user_by_pin(pin):
    try:
        res   = tabla_usuarios.scan(FilterExpression=Attr('pin_vinculacion').eq(pin))
        items = res.get('Items', [])
        return items[0] if items else None
    except Exception as e:
        print(f"_get_user_by_pin error: {e}")
        return None


def _link_device(email, device_id):
    tabla_usuarios.update_item(
        Key={'email': email},
        UpdateExpression='SET alexa_user_id = :d',
        ExpressionAttributeValues={':d': device_id},
    )


def _get_asignaturas(email):
    try:
        res   = tabla_unidades.scan(FilterExpression=Attr('email').eq(email))
        items = res.get('Items', [])
        return sorted(set(i['nombre_asignatura'] for i in items))
    except Exception as e:
        print(f"_get_asignaturas error: {e}")
        return []


def _get_unidades(email, asignatura):
    try:
        res = tabla_unidades.scan(
            FilterExpression=(
                Attr('email').eq(email) &
                Attr('nombre_asignatura').eq(asignatura) &
                Attr('estado').eq('listo')
            )
        )
        items = res.get('Items', [])
        return [i['nombre_unidad'] for i in sorted(items, key=lambda x: x.get('fecha_creacion', ''))]
    except Exception as e:
        print(f"_get_unidades error: {e}")
        return []


def _guardar_historial(email, asignatura, unidad, tipo, n, aciertos):
    try:
        tabla_historial.put_item(Item={
            'email':             email,
            'fecha_hora':        datetime.utcnow().isoformat(),
            'id_historial':      str(uuid.uuid4()),
            'nombre_asignatura': asignatura,
            'nombre_unidad':     unidad,
            'tipo_cuestionario': tipo,
            'num_preguntas':     n,
            'aciertos':          aciertos,
        })
    except Exception as e:
        print(f"_guardar_historial error: {e}")


# ── Builder de respuesta Alexa ────────────────────────────────────────────────

def _resp(speech, attrs=None, end=False):
    r = {
        'version': '1.0',
        'response': {
            'outputSpeech': {'type': 'PlainText', 'text': speech},
            'shouldEndSession': end,
        },
    }
    if attrs is not None:
        r['sessionAttributes'] = attrs
    return r
