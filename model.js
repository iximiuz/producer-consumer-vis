(function() {
  'use strict';

  function EventLoop() {
    this._events = [];
    this._current = void 0;
    this._startAt = Date.now();
  }

  EventLoop.prototype.push = function(ev) {
    ev.time = (this._current ? this._current.time : 0) + ev.delay;
    ev.parent = this._current;

    this._events.push(ev);
    this._events.sort(function(e1, e2) {
      return e1.time - e2.time;
    });
  };

  EventLoop.prototype.pushImmediate = function(ev) {
    ev.time = this._current ? this._current.time : 0;
    ev.parent = this._current;
    this._events.unshift(ev);
  };

  EventLoop.prototype.nextEventDelay = function() {
    return (this._current && this._events.length)
      ? this._events[0].time - this._current.time 
      : 0;
  };

  EventLoop.prototype.execute = function() {
    this._current = this._events.shift();
    console.debug(
      (Date.now() - this._startAt) + ':', 
      this._current.run.name, 
      'at', 
      this._current.time,
      '(delay', this._current.delay, ')'
    );
    this._current.run();
  };

  EventLoop.prototype.empty = function() {
    return this._events.length === 0;
  };


  function Producer(eventLoop, consumer, options) {
    options = options || {};
    this._eventLoop = eventLoop;
    this._consumer = consumer;
    this._state = 'paused';
    this._delay = delayFromRange(options.delay || [1000, 1000]),
    this._count = options.count || 50;
    this._chunk = {id: 0, progress: 0};
    this._produced = 0;
    this._backpressure = false;

    this._consumer.subOnDrain(function () {
      this._backpressure = false;
      this.resume();
    }.bind(this));
  }

  Producer.prototype.toJSON = function() {
    return {
      state: this._state,
      chunk: this._chunk,
      backpressure: this._backpressure
    };
  };

  Producer.prototype.resume = function() {
    this._state = 'resuming';
    var self = this;
    this._eventLoop.pushImmediate({
      run: function produceEvent() { self._produce(); }
    });
  };

  Producer.prototype._produce = function() {
    if (this._chunk === null) {
      return this._end();
    }

    this._state = 'producing';
    var self = this;
    if (this._chunk.progress === 100) {
      this._delay = delayFromRange(this._delay.range);
      this._produced++;
      this._eventLoop.push({
        delay: 0,
        run: function pushEvent() { self._push(); }
      });
    } else {
      this._chunk.progress += 10;
      this._eventLoop.push({
        delay: this._delay.value / 10,
        run: function produceContinuationEvent() { self._produce(); }
      });
    }
  };

  Producer.prototype._push = function(chunk) {
    this._state = 'pushing';
    var self = this;
    this._eventLoop.pushImmediate({
      run: function writeEvent() {
        self._backpressure = !self._consumer.write(self._chunk);
        self._chunk = (self._produced < self._count)
          ? {id: self._chunk.id + 1, progress: 0}
          : null;
        if (self._backpressure) {
          self._state = 'paused';
        } else {
          self._produce();
        }
      }
    });
  };

  Producer.prototype._end = function(chunk) {
    this._state = 'ended';
    this._backpressure = false;
    var self = this;
    this._eventLoop.push({
      delay: 0,
      run: function pushEnd() { self._consumer.write(null); }
    });
  };


  function Consumer(eventLoop, options) {
    options = options || {};
    this._eventLoop = eventLoop;
    this._state = 'idling';
    this._delay = delayFromRange(options.delay || [2000, 2000]);
    this._queue = [];
    this._queueCap = options.capacity || 3;
    this._chunk = void 0;
    this._draining = false;
    this._drainListeners = [];
    this._endCalled = false;
  }

  Consumer.prototype.toJSON = function() {
    return {
      state: this._state,
      chunk: this._chunk,
      queue: {
        cap: this._queueCap,
        chunks: this._queue,
      },
      draining: this._draining
    };
  };

  Consumer.prototype.write = function(chunk) {
    if (chunk === null) {
      this.end();
      return false;
    }

    if (this._queue.length >= this._queueCap) {
      throw new Error('Out of memory');
    }
    this._queue.push(chunk);
    if (this._state === 'idling') {
      this._resume();
    }
    return this._queue.length < this._queueCap;
  };

  Consumer.prototype.subOnDrain = function(cb) {
    this._drainListeners.push(cb);
  };

  Consumer.prototype.end = function() {
    this._endCalled = true;
  };

  Consumer.prototype._resume = function() {
    this._state = 'resuming';
    var self = this;
    this._eventLoop.pushImmediate({
      run: function pullEvent() { self._pull(); },
    });
  };

  Consumer.prototype._pull = function() {
    this._state = 'pulling';
    this._draining = (this._queue.length === this._queueCap);
    if (this._draining) {
      this._drainListeners.forEach(function(cb) { cb(); });
    }

    var self = this;
    this._chunk = this._queue.shift();
    this._eventLoop.pushImmediate({
      run: function consumeEvent() { self._consume(); }
    });
  };

  Consumer.prototype._consume = function() {
    this._state = this._endCalled ? 'flushing' : 'consuming';
    this._draining = false;

    var self = this;
    if (this._chunk.progress === 0) {
      this._delay = delayFromRange(this._delay.range);
      this._eventLoop.push({
        delay: 0,
        run: function pullEvent() {
          if (self._queue.length === 0) {
            self._chunk = void 0;
            self._state = self._endCalled ? 'finished' : 'idling';
          } else {
            self._pull();
          }
        }
      });
    } else {
      this._chunk.progress -= 10;
      this._eventLoop.push({
        delay: this._delay.value / 10, 
        run: function consumeContinuationEvent() { self._consume(); }
      });
    }
  };


  function Model(eventLoop, producer, consumer, renderer) {
    this._eventLoop = eventLoop;
    this._producer = producer;
    this._consumer = consumer;
    this._renderer = renderer;
    this._state = 'initial';
  }

  Model.prototype.render = function() {
    return this._renderer.draw({
      consumer: this._consumer.toJSON(),
      producer: this._producer.toJSON(),
    });
  };

  Model.prototype.start = function() {
    if (this._state === 'initial') {
      this._producer.resume();
    }

    if (this._state !== 'initial' && this._state !== 'paused') {
      throw new Error('Cannot start at this state');
    }
    this._state = 'running';

    var self = this;
    (function run() {
      delete self._tick;

      if (self._eventLoop.empty()) {
        self._state = 'finished';
        return;
      }

      self._next().then(function() {
        if (self._state === 'running') {
          self._tick = setTimeout(run, self._eventLoop.nextEventDelay());
        }
      });
    })();
  };

  Model.prototype.pause = function() {
    if (this._state !== 'running') {
      throw new Error('Cannot pause at this state');
    }

    if (this._tick) {
      clearInterval(this._tick);
      delete this._tick;
    }
    this._state = 'paused';
  };

  Model.prototype.isRunning = function() {
    return this._state === 'running';
  };

  Model.prototype.isPaused = function() {
    return this._state === 'paused';
  };

  Model.prototype._next = function() {
    this._eventLoop.execute();
    return this.render();
  };


  function Renderer(canvas, dimX, dimY, fps) {
    this._ctx = canvas.getContext('2d');
    this._width = canvas.width;
    this._height = canvas.height;
    this._dimX = dimX;
    this._dimY = dimY;
    this._unitX = Math.floor(this._width / this._dimX);
    this._unitY = Math.floor(this._height / this._dimY);
    this._fps = fps || 60;

    this._prodW = 5;
    this._prodH = 2;
    this._consW = 5;
    this._consH = 2;
    this._chunkW = 1;
    this._chunkH = 1;
    this._queueW = 1;
  }

  Renderer.prototype.clear = function() {
    this._ctx.clearRect(0, 0, this._width, this._height);
  };

  Renderer.prototype.draw = function(scene) {
    var producer = scene.producer;
    var consumer = scene.consumer;
    return new Promise(function(resolve) {
      if (producer.state === 'pushing') {
        return this._animatePushing(producer, consumer).then(resolve);
      }
      if (consumer.state === 'pulling') {
        return this._animatePulling(producer, consumer).then(resolve);
      } 

      this.clear();
      this._drawProducer(producer, consumer.queue);
      this._drawQueue(consumer.queue);
      this._drawConsumer(consumer);
      this._drawPauseHint();
      resolve();
    }.bind(this));
  };

  Renderer.prototype.drawText = function(message, x, y, options) {
    options = options || {};
    x = x * this._unitX;
    y = y * this._unitY;
    if (options.rotate !== void 0) {
      options.align = 'center';
      this._ctx.save();
      this._ctx.translate(x, y);
      this._ctx.rotate(options.rotate * Math.PI / 180.0);
      x = 0;
      y = 16;
    } 

    this._ctx.fillStyle = options.color || '#000';
    this._ctx.font = options.font || '24px Arial';
    this._ctx.textAlign = options.align || 'left';
    this._ctx.fillText(message, x, y);

    if (options.rotate !== void 0) {
      this._ctx.restore();
    }
  };

  Renderer.prototype.drawRect = function(x, y, w, h, options) {
    options = options || {};
    this._fillRect(x, y, w, h, options);
    if (options.border) {
      this._strokeRect(x, y, w, h, {
        radius: options.radius, 
        color: options.border
      });
    }
  };

  Renderer.prototype._fillRect = function(x, y, w, h, options) {
    if (options.radius) {
      this._rectRounded(x, y, w, h, options.radius);
    } else {
      this._rectPlain(x, y, w, h);
    }
    this._ctx.fillStyle = options.color || '#000';
    this._ctx.fill();
  };

  Renderer.prototype._strokeRect = function(x, y, w, h, options) {
    if (options.radius) {
      this._rectRounded(x, y, w, h, options.radius);
    } else {
      this._rectPlain(x, y, w, h);
    }
    this._ctx.strokeStyle = options.color || '#000';
    this._ctx.stroke();
  };

  Renderer.prototype._rectPlain = function(x, y, w, h) {
    this._ctx.beginPath();
    this._ctx.rect(
      x * this._unitX, 
      y * this._unitY, 
      w * this._unitX, 
      h * this._unitY
    );
  }
  
  Renderer.prototype._rectRounded = function(x, y, w, h, r) {
    x = x * this._unitX;
    y = y * this._unitY;
    w = w * this._unitX;
    h = h * this._unitY;

    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;

    this._ctx.beginPath();
    this._ctx.moveTo(x + r, y);
    this._ctx.arcTo(x + w, y, x + w, y + h, r);
    this._ctx.arcTo(x + w, y + h, x, y + h, r);
    this._ctx.arcTo(x, y + h, x, y, r);
    this._ctx.arcTo(x, y, x + w, y, r);
  }

  Renderer.prototype._drawProducer = function(producer, queue) {
    var x = this._prodX();
    var y = this._prodY();
    this.drawRect(x, y, this._prodW, this._prodH, {
      color: '#FFE0B2',
      border: '#000000',
      radius: 10
    });
    this.drawText(producerText(producer), this._dimX / 2, y + 0.6, {
      align: 'center'
    });
    if (producer.state === 'producing') {
      this._drawChunk(producer.chunk, this._chunkX(), y + 1);
    }
    if (producer.backpressure) {
      this._drawBackpressureWarn(queue);
    }
  }

  Renderer.prototype._drawConsumer = function(consumer) {
    var x = this._consX(consumer);
    var y = this._consY(consumer);
    this.drawRect(x, y, this._consW, this._consH, {
      color: '#FFE0B2',
      border: '#000000',
      radius: 10
    })
    this.drawText(consumerText(consumer), this._dimX / 2, y + 1.6, {
      align: 'center'
    });
    if (consumer.state === 'consuming' || consumer.state === 'flushing') {
      this._drawChunk(consumer.chunk, this._chunkX(), y);
    }
    if (consumer.draining) {
      this._drawDrainWarn(consumer.queue);
    }
  }

  Renderer.prototype._drawQueue = function(queue, offset) {
    var x = this._queueX();
    var y = this._queueY();
    offset = offset || 0;
    this.drawRect(x, y, this._queueW, this._queueH(queue), {
      color: '#FFF',
      border: '#000'
    });
    this.drawRect(
      x - 0.2, 
      y - 1/this._unitY, 
      this._queueW + 0.4, 
      2/this._unitY, 
      {color: '#FFF'}
    );
    this.drawRect(
      x - 0.2, 
      y - 1/this._unitY + this._queueH(queue), 
      this._queueW + 0.4, 
      2/this._unitY, 
      {color: '#FFF'}
    );
    for (var i = 0; i < queue.chunks.length; i++) {
      this._drawChunk(queue.chunks[i], x, y + queue.cap - i - 1 - offset);
    }
  }

  Renderer.prototype._drawChunk = function(chunk, x, y) {
    var payloadColor = (chunk.id % 2) ? '#F8CECC' : '#E1D5E7';
    this.drawRect(x, y, this._chunkW, this._chunkH, {
      color: 'white', 
      radius: 3
    });
    this.drawRect(x, y, this._chunkW * chunk.progress / 100, this._chunkH, {
      color: payloadColor, 
      radius: 3
    });
    this._strokeRect(x, y, this._chunkW, this._chunkH, {
      color: 'black', 
      radius: 3
    });
    this.drawText(chunk.id, x + 0.5, y + 0.65, {align: 'center'});
  }

  Renderer.prototype._drawBackpressureWarn = function(queue) {
    this.drawText(
      'Backpressure!', 
      this._queueX() + this._queueW + 1.5,
      this._queueY() + this._queueH(queue) / 2,
      {align: 'center', color: 'red', rotate: -30}
    );
  };

  Renderer.prototype._drawDrainWarn = function(queue) {
    this.drawText(
      'Draining!', 
      this._queueX() - 1.5,
      this._queueY() + this._queueH(queue) / 2,
      {align: 'center', color: 'green', rotate: -30}
    );
  };

  Renderer.prototype._drawPauseHint = function() {
    this.drawText(
      '(tap to pause/resume)', 
      this._dimX / 2, 
      this._dimY - 0.5, {
        align: 'center',
        font: 'italic 14px Arial'
    });
  };

  Renderer.prototype._animatePushing = function(producer, consumer) {
    var chunk = producer.chunk;
    var queue = consumer.queue;

    return new Promise(function(resolve) {
      var startY = this._prodY() + 1.5;
      var endY = this._queueY() + (queue.cap - queue.chunks.length - 1);
      var chunkY = startY;
      var totalDuration = 150 * (endY - startY);
      var frameDuration = 1000 / this._fps;
      var dY = (endY - startY) / (totalDuration / frameDuration);
      var int = setInterval(function() {
        chunkY = Math.min(endY, chunkY + dY);
        this.clear();
        this._drawProducer(producer, queue);
        this._drawQueue(queue);
        this._drawConsumer(consumer);
        this._drawChunk(chunk, this._chunkX(), chunkY);
        this._drawPauseHint();
        if (chunkY >= endY) {
          clearInterval(int);
          if (producer.backpressure) {
            setTimeout(resolve, 150);
          } else {
            resolve();
          }
        }
      }.bind(this), frameDuration);
    }.bind(this));
  };

  Renderer.prototype._animatePulling = function(producer, consumer) {
    var chunk = consumer.chunk;
    var queue = consumer.queue;

    return new Promise(function(resolve) {
      var startY = this._queueY() + this._queueH(queue) - 1;
      var endY = this._consY(consumer);
      var chunkY = startY;
      var totalDuration = 150 * (endY - startY);
      var frameDuration = 1000 / this._fps;
      var dY = (endY - startY) / (totalDuration / frameDuration);
      var anim = setInterval(function() {
        chunkY = Math.min(endY, chunkY + dY);
        this.clear();
        this._drawProducer(producer, queue);
        this._drawQueue(queue, 1);
        this._drawConsumer(consumer);
        this._drawChunk(chunk, this._chunkX(), chunkY);
        this._drawPauseHint();
        if (chunkY >= endY) {
          clearInterval(anim);
          if (consumer.draining) {
            setTimeout(function() {
              this._animateQueueShift(queue).then(resolve);
            }.bind(this), 150);
          } else {
            this._animateQueueShift(queue).then(resolve);
          }
        }
      }.bind(this), frameDuration);
    }.bind(this));
  };

  Renderer.prototype._animateQueueShift = function(queue) {
    return new Promise(function(resolve) {
      if (queue.chunks.length === 0) {
        return resolve();
      }

      var totalDuration = 150;
      var elapsed = 0;
      var frameDuration = 1000 / this._fps;
      var anim = setInterval(function() {
        if (elapsed >= totalDuration) {
          clearInterval(anim);
          return resolve();
        }

        this._drawQueue(queue, (totalDuration - elapsed) / totalDuration);
        elapsed += frameDuration;
      }.bind(this), frameDuration);
    }.bind(this));
  };

  Renderer.prototype._prodX = function() {
    return (this._dimX - this._prodW) / 2;
  };

  Renderer.prototype._prodY = function() {
    return 1;
  };

  Renderer.prototype._consX = function(consumer) {
    return (this._dimX - this._consW) / 2;
  };

  Renderer.prototype._consY = function(consumer) {
    return this._prodX() + this._prodH + 0.5 + this._queueH(consumer.queue) + 0.5;
  };

  Renderer.prototype._chunkX = function() {
    return (this._dimX - this._chunkW) / 2;
  };

  Renderer.prototype._queueX = function() {
    return this._chunkX();
  };

  Renderer.prototype._queueY = function() {
    return this._prodX() + this._prodH + 0.5;
  };

  Renderer.prototype._queueH = function(queue) {
    return queue.cap;
  };


  function producerText(producer) {
    var message = producer.state;
    return String.fromCharCode(message.charCodeAt(0) - 32) + message.slice(1);
  }

  function consumerText(consumer) {
    var message = consumer.state;
    return String.fromCharCode(message.charCodeAt(0) - 32) + message.slice(1);
  }

  function delayFromRange(range) {
    return {
      value: rand(range[0], range[1]),
      range: range
    };
  }

  function rand(a, b) {
    return a + Math.floor(Math.random() * (b - a + 1));
  }

  window.startModel = function startModel(options) {
    var canvas = document.getElementById(options.canvasId);
    canvas.width = options.canvasWidth || (options.dimX * 50);
    canvas.height = options.canvasHeight || (options.dimY * 50);

    var loop = new EventLoop();
    var consumer = new Consumer(loop, {
      delay: options.consumerDelay,
      capacity: options.queueCapacity
    });
    var producer = new Producer(loop, consumer, {
      delay: options.producerDelay,
      count: options.chunksCount
    });
    var model = new Model(
      loop,
      producer,
      consumer,
      new Renderer(canvas, options.dimX, options.dimY),
    );
    model.start();
    return model;
  }
})();

