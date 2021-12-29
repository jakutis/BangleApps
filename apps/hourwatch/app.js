function draw() {
  const topLeft = {x: 0, y: 0}
  const bottomRight = {x: 175, y: 175}
  const dimensions = {
    x: (bottomRight.x - topLeft.x),
    y: (bottomRight.y - topLeft.y),
  }
  const fontSize = dimensions.x * 0.85
  const margin = {top: 20, left: 5}
  const backgroundColor = '#FFFFFF'
  const fontColor = '#000000'

  var d = new Date();
  var h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
  var time = [h, m, s].map(t => ('0' + t).substr(-2)).join(':');

  g.reset();
  g.setColor(backgroundColor)
  g.fillRect(topLeft.x, topLeft.y, bottomRight.x, bottomRight.y);
  g.setFont("Vector", fontSize);
  g.setColor(fontColor)
  g.drawString(time, margin.left, margin.top);
  Bangle.drawWidgets();
}

Bangle.loadWidgets();
Bangle.setUI("clock");
g.clear();
draw();
var secondInterval = setInterval(draw, 60 * 1000);
