import { Component, DestroyRef, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { keepScreenAwake } from './wake-lock';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrls: ['./app.scss'],
})
export class App {
  constructor() {
    inject(DestroyRef).onDestroy(keepScreenAwake(navigator, document));
  }
}
