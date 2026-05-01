"""
Voice Quizzer — Alexa Skill Lambda Handler
==========================================
Sin dependencias externas: usa boto3 (built-in en Lambda) para DynamoDB, S3 y Bedrock.

Variables de entorno requeridas:
  AWS_BUCKET_NAME, AWS_REGION_NAME
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


# ── Extractor de JSON robusto ─────────────────────────────────────────────────

def _extraer_json(texto, array=True):
    """Extrae JSON del texto del LLM manejando múltiples arrays, markdown y texto extra."""
    import re
    texto = re.sub(r'```(?:json)?', '', texto).strip()

    if array:
        objetos = []
        depth   = 0
        start   = None
        for i, c in enumerate(texto):
            if c == '{':
                if depth == 0:
                    start = i
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0 and start is not None:
                    objetos.append(texto[start:i + 1])
                    start = None
        if objetos:
            return '[' + ','.join(objetos) + ']'
        inicio = texto.find('[')
        fin    = texto.rfind(']')
        if inicio != -1 and fin != -1 and fin > inicio:
            return texto[inicio:fin + 1]
    else:
        inicio = texto.find('{')
        fin    = texto.rfind('}')
        if inicio != -1 and fin != -1 and fin > inicio:
            return texto[inicio:fin + 1]

    return texto.strip()


# ── Bedrock (Claude 3 Haiku) ──────────────────────────────────────────────────

def _groq(messages, temperature=0.4, max_tokens=4000):
    """Llama a AWS Bedrock (Claude 3 Haiku) usando boto3."""

    bedrock = boto3.client('bedrock-runtime', region_name='eu-west-1')

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

    if not conv_messages:
        conv_messages = [{'role': 'user', 'content': [{'text': 'Hola'}]}]

    kwargs = {
        'modelId':         'anthropic.claude-3-haiku-20240307-v1:0',
        'messages':        conv_messages,
        'inferenceConfig': {
            'maxTokens':   max_tokens,
            'temperature': temperature,
        },
    }
    if system_content:
        kwargs['system'] = system_content

    try:
        resp  = bedrock.converse(**kwargs)
        texto = resp['output']['message']['content'][0]['text']
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

    val = _primer_slot(slots)

    # Stop/Cancel — si estamos repasando, guardamos el resumen parcial antes de salir
    if name in ('AMAZON.StopIntent', 'AMAZON.CancelIntent'):
        if estado == 'repasando':
            return _finalizar_repaso(attrs, cerrar=True)
        return _resp("Hasta luego.", end=True)

    # ── Routing por estado (tiene prioridad sobre el nombre del intent) ────────

    if estado == 'esperando_pin':
        if not val:
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

    if estado == 'repasando':
        # "no", "para", "finalizar" → parar el repaso
        if name in ('AMAZON.NoIntent', 'FinalizarIntent'):
            return _finalizar_repaso(attrs, cerrar=True)
        # Cualquier otra cosa (sí, continúa, etc.) → siguiente segmento
        return _siguiente_segmento(attrs)

    if estado == 'en_cuestionario':
        print(f"[QUIZ DEBUG] intent={name} val={repr(val)} slots={json.dumps(slots)}")
        if name == 'AMAZON.YesIntent':
            return _yes(attrs)
        if name == 'AMAZON.NoIntent':
            return _no(attrs)

        # Recoger el valor de cualquier slot que tenga contenido
        respuesta = val
        if not respuesta:
            for slot_obj in slots.values():
                sv = (slot_obj or {}).get('value', '') or ''
                if sv.strip():
                    respuesta = sv.strip()
                    break

        if not respuesta:
            try:
                respuesta = event['request'].get('intent', {}).get('slots', {}).get('respuesta', {}).get('value', '') or ''
            except Exception:
                pass

        if respuesta:
            return _evaluar_respuesta(attrs, respuesta)
        return _resp("No entendí. Di opción A, opción B u opción C.", attrs=attrs)

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
    """Intenta extraer un número de un texto en español."""
    if not texto:
        return None
    try:
        return int(float(str(texto).strip()))
    except (ValueError, TypeError):
        pass
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
        return _resp("No te he entendido. Tienes que decir, por ejemplo: quiero cinco, o quiero tres. Repite por favor.", attrs=attrs)

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
            f"Has elegido {unidad}. ¿Quieres repasar el temario o hacer un cuestionario?",
            attrs=attrs
        )

    elif estado == 'eligiendo_num_preguntas':
        if num < 1 or num > 20:
            return _resp("Elige un número entre 1 y 20.", attrs=attrs)
        attrs['num_preguntas'] = num
        return _generar_cuestionario(attrs)

    return _resp("No entendí. Repite el número.", attrs=attrs)


def _tipo(attrs, slots):
    val = (slots.get('tipo') or {}).get('value', '').lower().strip()

    # Normalizar tildes para facilitar la comparación
    val = (val.replace('á', 'a').replace('é', 'e').replace('í', 'i')
              .replace('ó', 'o').replace('ú', 'u'))

    if any(x in val for x in ['repas', 'resum', 'temario']):
        return _generar_repaso(attrs)

    if any(x in val for x in ['cuestion', 'test', 'examen', 'preguntas']):
        attrs.update({'tipo': 'test', 'estado': 'eligiendo_num_preguntas'})
        return _resp("Cuestionario. ¿Cuántas preguntas quieres? Entre 1 y 20.", attrs=attrs)

    return _resp(
        "Di 'repasar' para escuchar un resumen del temario, "
        "o 'cuestionario' para hacer un test.",
        attrs=attrs
    )


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
        o     = preg['opciones']
        msg   = (
            f"Continuamos. Pregunta {idx + 1} de {total}: {preg['pregunta']}. "
            f"Opción A: {o['A']}. Opción B: {o['B']}. Opción C: {o['C']}."
        )
        return _resp(msg, attrs=attrs)

    if attrs.get('estado') == 'preguntando_continuar':
        nombre = attrs.get('nombre', 'estudiante')
        return _resp(
            f"¡Muy bien, {nombre}! Ha sido un placer estudiar contigo. ¡Hasta pronto!",
            end=True
        )

    return _evaluar_respuesta(attrs, 'no')


# ── Repaso ────────────────────────────────────────────────────────────────────

def _segmentar(texto, max_chars=500):
    """Divide el texto en segmentos de ~max_chars caracteres cortando en párrafos."""
    parrafos = [p.strip() for p in texto.replace('\r\n', '\n').split('\n\n') if p.strip()]
    if not parrafos:
        parrafos = [texto.strip()]

    segmentos = []
    actual    = ''

    for parrafo in parrafos:
        if not actual:
            actual = parrafo
        elif len(actual) + len(parrafo) + 1 <= max_chars:
            actual += ' ' + parrafo
        else:
            segmentos.append(actual)
            actual = parrafo

    if actual:
        segmentos.append(actual)

    # Si algún segmento es demasiado largo, cortarlo por frases
    resultado = []
    for seg in segmentos:
        if len(seg) <= max_chars:
            resultado.append(seg)
        else:
            frases = seg.split('. ')
            grupo  = ''
            for frase in frases:
                if not grupo:
                    grupo = frase
                elif len(grupo) + len(frase) + 2 <= max_chars:
                    grupo += '. ' + frase
                else:
                    resultado.append(grupo if grupo.endswith('.') else grupo + '.')
                    grupo = frase
            if grupo:
                resultado.append(grupo if grupo.endswith('.') else grupo + '.')

    return resultado if resultado else [texto[:max_chars]]


def _generar_repaso(attrs):
    """Genera un resumen del temario con Claude y empieza a recitarlo por segmentos."""
    email      = attrs['email']
    asignatura = attrs['asignatura']
    unidad     = attrs['unidad']

    cache_key = f"{email}/{asignatura}/{unidad}"
    if cache_key not in _chunks_cache:
        s3_key = f"{email}/{asignatura}/{unidad}/index/chunks.json"
        try:
            obj    = s3.get_object(Bucket=BUCKET, Key=s3_key)
            chunks = json.loads(obj['Body'].read().decode('utf-8'))
            _chunks_cache[cache_key] = '\n\n'.join(chunks[:25])
        except Exception as exc:
            print(f"Error cargando chunks para repaso: {exc}")
            return _resp(
                "No pude cargar el contenido de esta unidad. "
                "Asegúrate de que su estado es 'listo' en la app web.",
                end=True
            )

    contexto = _chunks_cache[cache_key]

    prompt = (
        "Eres un profesor universitario. Resume el siguiente contenido educativo "
        "en aproximadamente un 35% de su extensión original, en español claro y bien estructurado. "
        "El resumen debe cubrir todos los conceptos importantes del temario. "
        "Escribe párrafos breves separados por una línea en blanco. "
        "NO incluyas títulos, numeraciones, viñetas ni texto introductorio. "
        "ESCRIBE ÚNICAMENTE el resumen.\n\n"
        f"Contenido:\n{contexto}"
    )

    try:
        resumen = _groq([{'role': 'user', 'content': prompt}], temperature=0.3, max_tokens=3000)
        print(f"[REPASO DEBUG] Resumen generado, longitud: {len(resumen)}")
    except Exception as exc:
        print(f"Error generando resumen: {exc}")
        return _resp("Hubo un error generando el resumen. Inténtalo de nuevo.", end=True)

    segmentos = _segmentar(resumen)
    total     = len(segmentos)
    print(f"[REPASO DEBUG] Segmentos: {total}")

    # Si solo hay un segmento, lo leemos, guardamos y pasamos a preguntando_continuar
    if total == 1:
        _guardar_resumen(email, asignatura, unidad, resumen)
        attrs.update({
            'estado':          'preguntando_continuar',
            'segmentos':       [],
            'segmento_actual': 0,
        })
        return _resp(
            f"Repaso de {unidad}: {segmentos[0]} "
            "¡Eso es todo el repaso! ¿Quieres estudiar otra cosa?",
            attrs=attrs
        )

    attrs.update({
        'estado':          'repasando',
        'segmentos':       segmentos,
        'segmento_actual': 0,
    })

    return _resp(
        f"Empezamos el repaso de {unidad}. Parte 1 de {total}. "
        f"{segmentos[0]} ¿Continúo?",
        attrs=attrs
    )


def _siguiente_segmento(attrs):
    """Avanza al siguiente segmento del repaso."""
    segmentos = attrs.get('segmentos', [])
    idx       = attrs.get('segmento_actual', 0) + 1
    total     = len(segmentos)

    if idx >= total:
        # Seguridad: todos los segmentos ya leídos
        _guardar_resumen(
            attrs.get('email', ''), attrs.get('asignatura', ''),
            attrs.get('unidad', ''), '\n\n'.join(segmentos)
        )
        attrs.update({'estado': 'preguntando_continuar', 'segmentos': [], 'segmento_actual': 0})
        attrs.pop('asignatura', None)
        attrs.pop('unidad', None)
        return _resp("¡Repaso completado! ¿Quieres estudiar otra cosa?", attrs=attrs)

    attrs['segmento_actual'] = idx
    seg = segmentos[idx]

    # ¿Es el último segmento?
    if idx + 1 >= total:
        _guardar_resumen(
            attrs.get('email', ''), attrs.get('asignatura', ''),
            attrs.get('unidad', ''), '\n\n'.join(segmentos)
        )
        attrs.update({'estado': 'preguntando_continuar', 'segmentos': [], 'segmento_actual': 0})
        attrs.pop('asignatura', None)
        attrs.pop('unidad', None)
        return _resp(
            f"Parte {idx + 1} de {total}. {seg} "
            "¡Eso es todo el repaso! ¿Quieres estudiar otra cosa?",
            attrs=attrs
        )

    return _resp(f"Parte {idx + 1} de {total}. {seg} ¿Continúo?", attrs=attrs)


def _finalizar_repaso(attrs, cerrar=False):
    """Guarda el resumen parcial/completo y termina el repaso."""
    segmentos = attrs.get('segmentos', [])
    if segmentos:
        _guardar_resumen(
            attrs.get('email', ''),
            attrs.get('asignatura', ''),
            attrs.get('unidad', ''),
            '\n\n'.join(segmentos)
        )

    if cerrar:
        return _resp(
            "De acuerdo, paramos el repaso. El resumen ha sido guardado. ¡Hasta pronto!",
            end=True
        )

    # Completado sin cerrar sesión
    attrs.update({'estado': 'preguntando_continuar', 'segmentos': [], 'segmento_actual': 0})
    attrs.pop('asignatura', None)
    attrs.pop('unidad', None)
    return _resp("¡Repaso completado! ¿Quieres estudiar otra cosa?", attrs=attrs)


def _guardar_resumen(email, asignatura, unidad, resumen):
    """Guarda el resumen en el campo 'resumen' de VQ_Unidad."""
    if not email or not asignatura or not unidad or not resumen:
        return
    try:
        id_unidad       = f"{email}#{asignatura}#{unidad}"
        detalle_archivo = f"{asignatura}#{unidad}"
        tabla_unidades.update_item(
            Key={
                'id_unidad':       id_unidad,
                'detalle_archivo': detalle_archivo,
            },
            UpdateExpression='SET resumen = :r',
            ExpressionAttributeValues={':r': resumen},
        )
        print(f"[REPASO DEBUG] Resumen guardado para '{unidad}'")
    except Exception as e:
        print(f"_guardar_resumen error: {e}")


# ── Lógica del cuestionario (solo test) ──────────────────────────────────────

def _generar_cuestionario(attrs):
    email      = attrs['email']
    asignatura = attrs['asignatura']
    unidad     = attrs['unidad']
    n          = attrs['num_preguntas']

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

    prompt = (
        f"Eres un profesor. Genera exactamente {n} preguntas de tipo test DIFERENTES entre sí en español, "
        f"basándote SOLO en este contenido:\n\n{contexto}\n\n"
        f"IMPORTANTE: Las {n} preguntas deben tratar aspectos o conceptos DISTINTOS del contenido. "
        "Cada pregunta tiene EXACTAMENTE 3 opciones: A, B y C. Solo una es correcta. "
        "RESPONDE ÚNICAMENTE CON UN ARRAY JSON VÁLIDO y nada más, sin texto adicional, sin markdown:\n"
        '[{"pregunta":"¿...?","opciones":{"A":"...","B":"...","C":"..."},'
        '"correcta":"A","explicacion":"La respuesta es A porque..."}]'
    )

    try:
        raw = _groq([{'role': 'user', 'content': prompt}], temperature=0.4, max_tokens=4000)
        print(f"[RAW LLM] >>>{raw[:800]}<<<")
        extraido  = _extraer_json(raw, array=True)
        preguntas = json.loads(extraido)
    except Exception as exc:
        print(f"Error generando preguntas: {exc}")
        return _resp("Hubo un error generando las preguntas. Inténtalo de nuevo.", end=True)

    if len(preguntas) < n:
        preguntas = (preguntas * (n // len(preguntas) + 1))[:n]
    preguntas = preguntas[:n]

    attrs.update({
        'estado':          'en_cuestionario',
        'tipo':            'test',
        'preguntas':       preguntas,
        'pregunta_actual': 0,
        'aciertos':        0,
    })

    primera = preguntas[0]
    o       = primera['opciones']
    msg = (
        f"Perfecto. Para responder di 'opción A', 'opción B' u 'opción C'. "
        f"Pregunta 1 de {n}: {primera['pregunta']} "
        f"Opción A: {o['A']}. Opción B: {o['B']}. Opción C: {o['C']}."
    )

    return _resp(msg, attrs=attrs)


def _evaluar_respuesta(attrs, respuesta_val):
    if attrs.get('estado') != 'en_cuestionario':
        return _resp("No hay ningún cuestionario activo.", attrs=attrs)

    preguntas = attrs.get('preguntas', [])
    idx       = attrs.get('pregunta_actual', 0)
    aciertos  = attrs.get('aciertos', 0)
    pregunta  = preguntas[idx]

    import re as _re
    raw_resp = str(respuesta_val).strip().lower()
    raw_norm = (raw_resp
                .replace('ó', 'o').replace('á', 'a').replace('é', 'e')
                .replace('í', 'i').replace('ú', 'u'))
    letra = ''
    m = _re.search(r'opci[oa]n\s*([abc])', raw_norm)
    if m:
        letra = m.group(1).upper()
    else:
        m = _re.search(r'\b([abc])\b', raw_norm)
        if m:
            letra = m.group(1).upper()
        else:
            for ch in raw_norm:
                if ch in ('a', 'b', 'c'):
                    letra = ch.upper()
                    break

    print(f"[TEST DEBUG] raw={repr(raw_resp)} letra={letra}")
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

    idx += 1
    n   = len(preguntas)

    if idx >= n:
        _guardar_historial(
            email      = attrs['email'],
            asignatura = attrs['asignatura'],
            unidad     = attrs['unidad'],
            tipo       = 'test',
            n          = n,
            aciertos   = aciertos,
        )
        pct  = round(aciertos / n * 100)
        nota = ("¡Excelente resultado!" if pct >= 80
                else "Buen trabajo, sigue practicando." if pct >= 60
                else "Necesitas repasar este tema. ¡Ánimo!")
        attrs.update({
            'estado':          'preguntando_continuar',
            'preguntas':       [],
            'pregunta_actual': 0,
            'aciertos':        0,
        })
        attrs.pop('asignatura', None)
        attrs.pop('unidad', None)
        attrs.pop('tipo', None)
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
    o         = siguiente['opciones']
    msg = (
        f"{feedback} Pregunta {idx + 1} de {n}: {siguiente['pregunta']} "
        f"Opción A: {o['A']}. Opción B: {o['B']}. Opción C: {o['C']}."
    )
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
