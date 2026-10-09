# plugin-scanner

**Scanner** para [FlickerTalk](https://flickertalk.com). Convierte la foto de un papel en un
documento: se marcan las cuatro esquinas, el plugin endereza la perspectiva, lo deja en blanco y
negro limpio si se quiere, y lo envía como PDF (una página por foto) o como imagen.

Todo ocurre en el teléfono: el plugin no tiene red, no ve la conversación ni las claves, y solo
recibe la foto que **el usuario** hace con la cámara, elige en el selector del sistema o le
entrega con «Abrir con». El
enderezado es una homografía calculada aquí, sin ninguna biblioteca; el PDF se escribe byte a byte,
como en [plugin-pdf](https://github.com/FlickerTalk/plugin-pdf). Lo que produce lo envía la app,
nunca el plugin.

## Qué hace

- **Hacer la foto con la cámara** o **elegir una foto**, o abrir una imagen del chat con «Abrir con» →
  Scanner. Con la app 1.4.1 o posterior, al abrirlo se elige entre la cámara y la galería; en una
  app anterior se abre la galería directamente, como antes.
- **Cuatro esquinas** arrastrables sobre la foto; empiezan en un marco interior y se ajustan con el
  dedo. El documento resultante tiene el tamaño medio de los lados marcados, hasta 1600 px.
- **Modo documento**: gris, el papel a blanco y la tinta a negro, con un umbral que sigue la luz
  de la propia página (una foto oscura sigue saliendo como papel). Se puede apagar para conservar
  el color.
- **Varias páginas**: cada escaneo se añade a la lista y se puede quitar.
- **Enviar como PDF** (una página por escaneo, en A4 con margen) o **como imagen** (la página
  actual, JPEG).

## Qué es un plugin de FlickerTalk

Una carpeta con un `module.json` y un `dist/index.js` que registra un web component. Corre dentro
de un iframe aislado (origen opaco, CSP propia) y solo puede usar lo que el núcleo expone. El
contrato está en [plugin-sdk](https://github.com/FlickerTalk/plugin-sdk).

Desde la 1.0.3 la ventana va en los envoltorios de Ionic que la app presta al marco (barra en
`ion-header`, cuerpo en `ion-content`, botones de Ionic), así que se ve como el resto de
FlickerTalk; pide la app 1.6.0 (`minCoreVersion`) y el paquete no lleva Ionic. `@ionic/core` es
solo `devDependency`, para que los tests pinten lo mismo que el teléfono.

## Desarrollo

```sh
npm install
npm test
```

El paquete `.ftplugin` lo firma el catálogo de FlickerTalk; no se construye aquí.

## Licencia

MIT.
