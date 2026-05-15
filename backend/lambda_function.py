"""
Autor:   María León Pérez
Resumen: Handler principal de la Alexa Skill de Voice Quizzer, desplegado como función AWS Lambda.
         Implementa una máquina de estados conversacional que gestiona la vinculación de cuenta
         por PIN, la selección de asignatura/unidad, el modo 'repasar' (resumen generado por
         Claude 3 Haiku recitado en segmentos) y el modo 'test' (cuestionario tipo test con
         evaluación automática). Persiste el historial en DynamoDB y los resúmenes en VQ_Unidad.
         No requiere dependencias externas: usa únicamente boto3 (built-in en el runtime Lambda).

Variables de entorno requeridas:
  AWS_BUCKET_NAME   — bucket S3 donde se almacenan los chunks.json de cada unidad
  AWS_REGION_NAME   — región AWS del bucket y de las tablas DynamoDB (ej. eu-west-3)
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
    """Extrae JSON válido del texto devuelto por el LLM.

    El modelo a veces envuelve la respuesta en bloques markdown (```json) o añade
    texto explicativo antes/después del JSON. Esta función lo elimina y localiza
    el JSON real usando dos estrategias:
      - array=True: recorre carácter a carácter buscando objetos {...} independientes
        y los reensambla en un array; si falla, busca el primer '[' y el último ']'.
      - array=False: busca el primer '{' y el último '}'.
    """
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

def _llm(messages, temperature=0.4, max_tokens=4000):
    """Invoca Claude 3 Haiku en AWS Bedrock mediante la API Converse.

    Se usa la región eu-west-1 (única que expone Claude 3 Haiku en Bedrock Europa).
    El parámetro 'system' se separa de los mensajes de conversación porque la API
    Converse lo requiere como campo de nivel superior, no como mensaje con role='system'.
    La temperatura baja (0.3–0.4) es deliberada: queremos respuestas consistentes y
    factuales, no creativas.
    """

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
    """Punto de entrada de la Lambda. Alexa envía un JSON con 'request.type':
      - LaunchRequest: el usuario abre la skill sin decir nada.
      - IntentRequest: el usuario ha dicho algo que Alexa ha clasificado como intent.
      - SessionEndedRequest: la sesión terminó de forma abrupta (timeout, error).
    """
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
    """Gestiona la apertura de la skill. Si el dispositivo ya está vinculado a una
    cuenta, saluda al usuario por su nombre y lista sus asignaturas. Si no, solicita
    el PIN de vinculación de 6 dígitos.
    """
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
    """Router central de la máquina de estados. El estado ('estado') guardado en
    sessionAttributes tiene PRIORIDAD sobre el nombre del intent: esto permite que el
    usuario diga cualquier cosa mientras está en un estado determinado sin que Alexa
    confunda el intent. Los intents globales (Stop, Cancel, Help) se procesan siempre
    antes del routing por estado.
    """
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
        # Pasamos los slots originales del evento para que _tipo
        # pueda escanear TODOS los slots y usar el nombre del intent
        return _tipo(attrs, slots, intent_name=name)

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
    """Devuelve el valor literal del primer slot no vacío del intent."""
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
    """Extrae un entero del texto recibido de Alexa, soportando dígitos y palabras en español.
    Alexa puede enviar el número como texto ("tres") o como cifra ("3").
    """
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
    """Vincula el dispositivo Alexa a una cuenta de usuario mediante PIN de 6 dígitos.
    Busca el PIN en la tabla VQ_Usuarios y, si existe, asocia el deviceId de Alexa al
    email del usuario (campo alexa_user_id). Esta vinculación es equivalente al
    mecanismo de TV pairing de Netflix/Disney+: el usuario ve el PIN en la app web y lo
    dice en voz alta a Alexa para emparejar el dispositivo sin necesidad de teclado.
    """
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
    """Maneja la selección numérica en tres estados distintos:
      - eligiendo_asignatura: selecciona asignatura de la lista del usuario.
      - eligiendo_unidad: selecciona unidad y pasa a eligiendo_tipo.
      - eligiendo_num_preguntas: valida rango 1-20 y lanza _generar_cuestionario.
    """
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


def _tipo(attrs, slots, intent_name=''):
    """Detecta si el usuario quiere repasar o hacer un cuestionario.

    Estrategia en capas para ser lo más resiliente posible:
    1. Recopilar texto de TODOS los slots disponibles.
    2. Usar también el nombre del intent como pista.
    3. Buscar palabras clave en el texto combinado.
    """
    def _norm(t):
        return (str(t).lower()
                .replace('á','a').replace('é','e').replace('í','i')
                .replace('ó','o').replace('ú','u').replace('ñ','n'))

    # --- Recopilar texto de todos los slots (valor directo + valor resuelto) ---
    fragmentos = []
    for slot_obj in (slots or {}).values():
        if not slot_obj:
            continue

        # 1) Valor literal (lo que el usuario dijo)
        sv = slot_obj.get('value', '') or ''
        if sv.strip():
            fragmentos.append(_norm(sv.strip()))

        # 2) Valor canónico resuelto (resolutions, más fiable con sinónimos)
        try:
            resolved = (slot_obj['resolutions']
                        ['resolutionsPerAuthority'][0]
                        ['values'][0]['value']['name'])
            if resolved and resolved.strip():
                fragmentos.append(_norm(resolved.strip()))
        except (KeyError, IndexError, TypeError):
            pass

    texto = ' '.join(fragmentos)

    # --- El nombre del intent también puede darnos una pista ---
    intent_norm = _norm(intent_name)

    print(f"[TIPO DEBUG] texto_slots={repr(texto)} intent={intent_name}")

    # --- Detectar "repasar" ---
    palabras_repaso = ['repas', 'resum', 'temario']
    if any(p in texto for p in palabras_repaso) or any(p in intent_norm for p in palabras_repaso):
        return _generar_repaso(attrs)

    # --- Detectar "cuestionario / test" ---
    palabras_test = ['cuestion', 'test', 'examen', 'preguntas', 'quiz']
    if any(p in texto for p in palabras_test) or any(p in intent_norm for p in palabras_test):
        attrs.update({'tipo': 'test', 'estado': 'eligiendo_num_preguntas'})
        return _resp("Cuestionario. ¿Cuántas preguntas quieres? Entre 1 y 20.", attrs=attrs)

    return _resp(
        "No te he entendido. Di 'repasar' para escuchar un resumen del temario, "
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
    """Divide el resumen en segmentos aptos para la síntesis de voz de Alexa.
    Alexa tiene un límite práctico de ~600 caracteres por respuesta antes de que
    el texto suene monótono o se corte. El algoritmo prioriza cortar en párrafos
    (doble salto de línea) y, si un párrafo es demasiado largo, corta por frases.
    """
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


def _limpiar_intro(texto):
    """Elimina frases introductorias que el LLM incluye pese a la instrucción explícita
    de no hacerlo ('Aquí te presento el resumen:', 'A continuación...'). Es un problema
    conocido de los modelos de lenguaje: aunque el prompt diga 'ESCRIBE ÚNICAMENTE el
    resumen', el modelo tiende a añadir una frase de cortesía inicial.
    """
    import re
    patron = re.compile(
        r'^(aqu[ií]\s+(?:te\s+)?(?:presento|está|tienes)\s+el\s+resumen[^:\n]*[:\n]+|'
        r'a\s+continuaci[oó]n\s+(?:te\s+)?(?:presento|está)[^:\n]*[:\n]+|'
        r'el\s+siguiente\s+(?:es\s+el\s+)?resumen[^:\n]*[:\n]+|'
        r'resumen\s+del\s+contenido[^:\n]*[:\n]+)',
        re.IGNORECASE
    )
    return patron.sub('', texto).strip()


def _generar_repaso(attrs):
    """Genera un resumen del 35% del temario con Claude 3 Haiku y lo recita en segmentos.
    Los chunks.json de la unidad se cachean en el diccionario _chunks_cache (persiste
    entre invocaciones calientes de la misma Lambda) para evitar descargas repetidas de S3.
    Si el resumen cabe en un único segmento, se guarda y pasa directamente a
    'preguntando_continuar'; si no, entra en el estado 'repasando' y espera confirmación
    del usuario entre segmento y segmento.
    """
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
        resumen = _llm([{'role': 'user', 'content': prompt}], temperature=0.3, max_tokens=3000)
        resumen = _limpiar_intro(resumen)
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
    """Avanza al siguiente segmento del repaso y guarda el resumen completo en DynamoDB
    cuando se alcanza el último segmento. Incluye una comprobación de seguridad para el
    caso borde en que el índice ya haya superado el total (no debería ocurrir en flujo normal).
    """
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
    """Persiste el resumen (completo o parcial) en DynamoDB y concluye el repaso.
    Se llama tanto al completar todos los segmentos como cuando el usuario dice 'stop'
    a mitad del repaso. En este último caso (cerrar=True) termina la sesión de Alexa.
    Guardar el resumen parcial garantiza que el usuario pueda releer en la web lo que
    Alexa ya había recitado, aunque no haya escuchado el texto completo.
    """
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
    """Persiste el texto del resumen en el campo 'resumen' de la tabla VQ_Unidad.
    La clave compuesta es id_unidad (email#asignatura#unidad) + detalle_archivo
    (asignatura#unidad), igual que en el resto de operaciones sobre esa tabla.
    Los errores se capturan silenciosamente para no interrumpir el flujo conversacional.
    """
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
    """Genera el cuestionario tipo test usando RAG + Claude 3 Haiku.
    El prompt fuerza al modelo a responder SOLO con un array JSON válido (sin markdown
    ni texto extra) porque _extraer_json necesita encontrar los objetos del array.
    Si el modelo devuelve menos preguntas de las solicitadas, se repiten hasta completar n
    (caso borde que ocurre con unidades de contenido muy corto).
    """
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
        raw = _llm([{'role': 'user', 'content': prompt}], temperature=0.4, max_tokens=4000)
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
    """Evalúa la respuesta oral del usuario a la pregunta actual del test.
    La extracción de letra (A/B/C) usa tres niveles de regex en orden de especificidad:
      1. 'opción A/B/C' (lo más explícito).
      2. Letra sola como palabra entera (\b[abc]\b).
      3. Primera letra a/b/c que aparezca en el texto.
    Al finalizar el cuestionario guarda el resultado en VQ_Historial y transita a
    'preguntando_continuar' para ofrecer seguir estudiando sin reabrir la skill.
    """
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
    """Busca en VQ_Usuarios el usuario vinculado al deviceId de Alexa.
    Se usa Scan con FilterExpression porque DynamoDB no tiene un GSI sobre alexa_user_id
    en esta versión. Para un volumen de usuarios pequeño (TFG) el coste es asumible.
    """
    try:
        res   = tabla_usuarios.scan(FilterExpression=Attr('alexa_user_id').eq(device_id))
        items = res.get('Items', [])
        return items[0] if items else None
    except Exception as e:
        print(f"_get_user_by_device error: {e}")
        return None


def _get_user_by_pin(pin):
    """Busca el usuario cuyo pin_vinculacion coincide con el PIN dicho por el usuario."""
    try:
        res   = tabla_usuarios.scan(FilterExpression=Attr('pin_vinculacion').eq(pin))
        items = res.get('Items', [])
        return items[0] if items else None
    except Exception as e:
        print(f"_get_user_by_pin error: {e}")
        return None


def _link_device(email, device_id):
    """Asocia el deviceId de Alexa al usuario identificado por email en VQ_Usuarios."""
    tabla_usuarios.update_item(
        Key={'email': email},
        UpdateExpression='SET alexa_user_id = :d',
        ExpressionAttributeValues={':d': device_id},
    )


def _get_asignaturas(email):
    """Devuelve la lista ordenada de asignaturas del usuario consultando VQ_Unidad.
    Se deduplican con set() porque cada unidad tiene su propia fila en la tabla y
    el nombre de asignatura puede repetirse.
    """
    try:
        res   = tabla_unidades.scan(FilterExpression=Attr('email').eq(email))
        items = res.get('Items', [])
        return sorted(set(i['nombre_asignatura'] for i in items))
    except Exception as e:
        print(f"_get_asignaturas error: {e}")
        return []


def _get_unidades(email, asignatura):
    """Devuelve las unidades en estado 'listo' de una asignatura, ordenadas por fecha de creación.
    Solo se muestran unidades con estado='listo' (índice FAISS ya generado) porque si el
    índice no existe la Lambda no podrá cargar los chunks.json y el cuestionario fallará.
    """
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
    """Registra el resultado de un cuestionario en VQ_Historial.
    La clave de ordenación es fecha_hora (ISO 8601 UTC) más id_historial (UUID) como
    desempate, garantizando unicidad incluso si dos cuestionarios se completan en el mismo segundo.
    """
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
    """Construye el JSON de respuesta Alexa SDK v2.
    Si attrs es None no incluye sessionAttributes (Alexa borrará los atributos de sesión).
    end=True cierra la sesión; end=False mantiene el micrófono abierto esperando más input.
    """
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
