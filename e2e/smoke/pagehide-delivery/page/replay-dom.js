/**
 * Builds a moderately large DOM for scenario R before the load event, so replay's first full snapshot
 * includes it: 300 table rows of 6 cells, and 40 paragraphs in a hidden details panel.
 */
(function () {
  const statuses = ['pending', 'paid', 'shipped', 'delivered', 'returned'];
  const names = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Edsger Dijkstra', 'Barbara Liskov', 'Donald Knuth'];
  const body = document.querySelector('#grid tbody');
  for (let i = 0; i < 300; i++) {
    const row = document.createElement('tr');
    const cells = [
      'ORD-' + String(100000 + i),
      names[i % names.length],
      statuses[i % statuses.length],
      String((i * 7) % 13),
      '$' + ((i * 37.13) % 900).toFixed(2),
      '2026-11-' + String((i % 28) + 1).padStart(2, '0'),
    ];
    cells.forEach(function (text) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.appendChild(cell);
    });
    body.appendChild(row);
  }
  const details = document.getElementById('details-panel');
  for (let i = 0; i < 40; i++) {
    const paragraph = document.createElement('p');
    paragraph.textContent =
      'Shipment note ' + i + ': the parcel left the warehouse and is expected within three working days.';
    details.appendChild(paragraph);
  }
})();
