(function() {
  'use strict';

  var canvasId = 'canvas';
  var dimX = 7;
  var fpscOptions = {
    consumerDelay: [2000, 2000],
    producerDelay: [700, 700],
    chunksCount: 10,
    queueCapacity: 4,
    canvasId: canvasId,
    dimX: dimX
  };
  var spfcOptions = {
    consumerDelay: [700, 700],
    producerDelay: [2000, 2000],
    chunksCount: 10,
    queueCapacity: 4,
    canvasId: canvasId,
    dimX: dimX
  };
  var model = void 0;

  onClick('preset-fpsc', function() {
    start(fpscOptions);
  });

  onClick('preset-spfc', function() {
    start(spfcOptions);
  });

  onClick('preset-random', function() {
    var options = JSON.parse(JSON.stringify(fpscOptions));
    options.chunksCount = rand(6, 20);
    options.queueCapacity = rand(1, 5);
    options.producerDelay[0] = rand(250, 1500);
    options.producerDelay[1] = rand(options.producerDelay[0], 3000);
    options.consumerDelay[0] = rand(250, 1500);
    options.consumerDelay[1] = rand(options.consumerDelay[0], 3000);
    start(options);
  });

  onClick('options-apply', function() {
    var options = optionsPaneRead();
    options.canvasId = canvasId;
    options.dimX = dimX;
    start(options);
  });

  start(fpscOptions);

  if (window.location.search.indexOf('msrc=article') === -1) {
    var articleLink = document.getElementById('article');
    if (articleLink) {
      articleLink.style.display = 'block';
    }
  }

  // ---=== Utils ===---
  function start(options) {
    if (model && model.isRunning()) {
      model.pause();
    }
    recreateCanvas();
    options.dimY = 7 + (options.queueCapacity || 3);
    model = window.startModel(options);
    optionsPaneUpdate(options);
  }

  function onClick(id, cb) {
    document.getElementById(id).addEventListener('click', cb);
  }

  function recreateCanvas() {
    var container = document.getElementById('canvas-container');
    container.removeChild(document.getElementById(canvasId))

    var canvas = document.createElement('canvas');
    canvas.id = canvasId;
    container.appendChild(canvas);

    onClick(canvasId, function() {
      if (model.isRunning()) {
        model.pause();
      } else if (model.isPaused()) {
        model.start();
      } 
    });
  }

  function optionsPaneUpdate(options) {
    document.getElementById('prod-delay-min').value = options.producerDelay[0];
    document.getElementById('prod-delay-max').value = options.producerDelay[1];
    document.getElementById('cons-delay-min').value = options.consumerDelay[0];
    document.getElementById('cons-delay-max').value = options.consumerDelay[1];
    document.getElementById('chunks-count').value = options.chunksCount;
    document.getElementById('queue-cap').value = options.queueCapacity;
  }

  function optionsPaneRead() {
    return {
      producerDelay: [
        +document.getElementById('prod-delay-min').value,
        +document.getElementById('prod-delay-max').value
      ],
      consumerDelay: [
        +document.getElementById('cons-delay-min').value,
        +document.getElementById('cons-delay-max').value
      ],
      chunksCount: +document.getElementById('chunks-count').value,
      queueCapacity: +document.getElementById('queue-cap').value
    };
  }

  function rand(a, b) {
    return a + Math.floor(Math.random() * (b - a + 1));
  }
})();

